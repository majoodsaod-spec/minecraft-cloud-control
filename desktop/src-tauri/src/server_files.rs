use std::io::{Read,Write};
use std::sync::Arc;
use base64::Engine;
use sha2::{Digest,Sha256};

const STAGED_FILES:&str="server/pending-files.json";
const TEXT_LIMIT:usize=128*1024;
static FILE_BACKUP:OnceLock<tokio::sync::Mutex<Option<(u64,Arc<std::path::PathBuf>)>>> = OnceLock::new();

fn safe_server_file(path:&str,write:bool)->bool {
    if path.is_empty() {return !write;}
    if !valid_path(path){return false;}
    let parts=path.split('/').collect::<Vec<_>>();
    if parts.iter().any(|p|p.starts_with('.') ||
        ["playerdata","stats","advancements","cache","libraries","logs","crash-reports"]
        .contains(&p.to_ascii_lowercase().as_str())){return false;}
    let name=parts.last().copied().unwrap_or("");
    let lower_name=name.to_ascii_lowercase();
    if ["key.pem","eula.txt","usercache.json","ops.json","whitelist.json",
        "banned-players.json","banned-ips.json","credentials.json","secrets.json"]
        .contains(&lower_name.as_str()){return false;}
    if parts.len()>=3&&parts[0]=="plugins"&&parts[1].eq_ignore_ascii_case("Geyser-Spigot")&&name=="config.yml"{return false;}
    if write {
        if parts.iter().any(|p|p.eq_ignore_ascii_case("world")||p.to_ascii_lowercase().starts_with("world_")){return false;}
        if lower_name=="server.properties"{return false;}
        if !["txt","json","yml","yaml","properties","conf","cfg","toml","md"].contains(&name.rsplit('.').next().unwrap_or("")){return false;}
    }
    true
}
fn decode_content(value:&Value)->Result<String,String>{
    let value=value["content"].as_str().ok_or("No file contents returned by GitHub")?;
    let compact=value.chars().filter(|c|!c.is_whitespace()).collect::<String>();
    let bytes=base64::engine::general_purpose::STANDARD.decode(compact)
        .map_err(|_|"Invalid GitHub file encoding")?;
    String::from_utf8(bytes).map_err(|_|"File is not valid UTF-8".into())
}
fn encode_content(text:&str)->String{base64::engine::general_purpose::STANDARD.encode(text.as_bytes())}
async fn pending_files()->Result<(Value,String),String>{
    let file=github(&format!("/contents/{STAGED_FILES}?ref=main"),reqwest::Method::GET,None).await?;
    let value=serde_json::from_str::<Value>(&decode_content(&file)?)
        .map_err(|_|"Invalid staged file manifest")?;
    if !value.is_object(){return Err("Staged file manifest is not an object".into())}
    Ok((value,file["sha"].as_str().ok_or("Missing staged file revision")?.to_owned()))
}
#[tauri::command]
async fn server_files_pending()->Result<Value,String>{
    Ok(pending_files().await?.0)
}
#[tauri::command]
async fn server_files_stage(path:String,content:String)->Result<Value,String>{
    if !safe_server_file(&path,true){return Err("This path is protected. Use Server Settings for server.properties. World files are read-only.".into())}
    if content.len()>TEXT_LIMIT||content.contains('\0'){return Err("Only UTF-8 text up to 128 KiB can be staged".into())}
    let (operations,_)=pending_operations().await?;
    if operations["operations"].as_array().is_some_and(|items|items.iter().any(|op|
        op["path"].as_str()==Some(path.as_str())||op["target"].as_str()==Some(path.as_str())
    )){return Err("Discard the queued rename/delete for this file before editing it".into())}
    let (mut manifest,sha)=pending_files().await?;
    if manifest.as_object().map(|m|m.len()>250).unwrap_or(true){return Err("Too many staged files".into())}
    manifest.as_object_mut().unwrap().insert(path.clone(),json!(content));
    let data=serde_json::to_string_pretty(&manifest).map_err(|_|"Cannot serialize staged files")?;
    if data.len()>800_000{return Err("Staged files exceed repository limit".into())}
    github(&format!("/contents/{STAGED_FILES}"),reqwest::Method::PUT,
        Some(json!({"branch":"main","sha":sha,"message":"Queue server file edits for next Paper session",
        "content":encode_content(&(data+"\n"))}))).await?;
    Ok(json!({"ok":true,"path":path,"nextSession":true}))
}
#[tauri::command]
async fn server_files_unstage(path:String)->Result<Value,String>{
    if !safe_server_file(&path,true){return Err("Invalid staged file path".into())}
    let (mut manifest,sha)=pending_files().await?;
    manifest.as_object_mut().unwrap().remove(&path);
    let data=serde_json::to_string_pretty(&manifest).map_err(|_|"Invalid staged files")?;
    github(&format!("/contents/{STAGED_FILES}"),reqwest::Method::PUT,
        Some(json!({"branch":"main","sha":sha,"message":"Discard queued server file edit",
        "content":encode_content(&(data+"\n"))}))).await?;
    Ok(json!({"ok":true}))
}
// The offline viewer streams backup archives to per-process disk files,
// rather than imposing an arbitrary snapshot-size or RAM limit.
async fn verified_backup()->Result<(u64,Arc<std::path::PathBuf>),String>{
    let artifacts=github("/actions/artifacts?name=minecraft-world&per_page=50",reqwest::Method::GET,None).await?;
    let chosen=artifacts["artifacts"].as_array().ok_or("Backup listing unavailable")?
        .iter().filter(|a|a["name"]=="minecraft-world"&&a["expired"]==false)
        .max_by_key(|a|a["created_at"].as_str().unwrap_or(""))
        .ok_or("No verified server backup exists yet")?;
    let id=chosen["id"].as_u64().ok_or("Missing backup ID")?;
    let cache=FILE_BACKUP.get_or_init(||tokio::sync::Mutex::new(None));
    {
        let guard=cache.lock().await;
        if let Some((cached,path))=&*guard {
            if *cached==id && path.is_file(){return Ok((id,Arc::clone(path)))}
        }
    }
    let token=secret(GITHUB_SECRET)?;
    let response=http().get(format!("https://api.github.com/repos/{REPO}/actions/artifacts/{id}/zip"))
        .bearer_auth(token).header("Accept","application/vnd.github+json")
        .send().await.map_err(|_|"Unable to retrieve the world backup")?;
    if !response.status().is_success(){return Err(format!("Backup download HTTP {}",response.status().as_u16()))}

    let folder=std::env::temp_dir().join(format!("minecraft-cloud-view-{}",std::process::id()));
    tokio::fs::create_dir_all(&folder).await.map_err(|_|"Cannot create backup viewer cache")?;
    let artifact_path=folder.join(format!("{id}.artifact.zip"));
    let snapshot_path=folder.join(format!("{id}.worlds.zip"));
    let outcome:Result<(),String>=async {
        use tokio::io::AsyncWriteExt;
        let mut outer=tokio::fs::File::create(&artifact_path).await
            .map_err(|_|"Cannot create backup download file")?;
        let mut chunks=response.bytes_stream();
        while let Some(part)=chunks.next().await{
            let part=part.map_err(|_|"Backup transfer interrupted")?;
            outer.write_all(&part).await.map_err(|_|"Not enough free disk space for backup")?;
        }
        outer.flush().await.map_err(|_|"Cannot finish backup download")?;
        drop(outer);
        let source=artifact_path.clone();
        let dest=snapshot_path.clone();
        tokio::task::spawn_blocking(move||->Result<(),String>{
            let outer=std::fs::File::open(source).map_err(|_|"Cannot open downloaded backup")?;
            let mut artifact=zip::ZipArchive::new(outer).map_err(|_|"Invalid GitHub artifact ZIP")?;
            let mut expected=String::new();
            {
                let mut hash=artifact.by_name("worlds.zip.sha256")
                    .map_err(|_|"Backup missing checksum")?;
                hash.take(256).read_to_string(&mut expected)
                    .map_err(|_|"Cannot read backup checksum")?;
            }
            let mut hasher=Sha256::new();
            {
                let mut backup=artifact.by_name("worlds.zip")
                    .map_err(|_|"Backup missing worlds.zip")?;
                let mut out=std::fs::File::create(dest)
                    .map_err(|_|"Cannot create backup snapshot cache")?;
                let mut buffer=[0_u8;128*1024];
                loop{
                    let read=backup.read(&mut buffer).map_err(|_|"Cannot extract snapshot")?;
                    if read==0{break;}
                    hasher.update(&buffer[..read]);
                    out.write_all(&buffer[..read])
                        .map_err(|_|"Not enough free disk space for backup snapshot")?;
                }
                out.flush().map_err(|_|"Cannot finalize snapshot cache")?;
            }
            if format!("{:x}",hasher.finalize())!=expected.trim(){
                return Err("Backup SHA-256 mismatch; refusing to open".into());
            }
            Ok(())
        }).await.map_err(|_|"Backup verification thread failed")?
    }.await;
    // The outer artifact is no longer needed after checksum verification.
    let _=tokio::fs::remove_file(&artifact_path).await;
    if let Err(err)=outcome{
        let _=tokio::fs::remove_file(&snapshot_path).await;
        return Err(err)
    }
    let snapshot_path=Arc::new(snapshot_path);
    let mut guard=cache.lock().await;
    if let Some((old_id,old_path))=guard.take(){
        if old_id!=id && old_path!=snapshot_path {
            let _=tokio::fs::remove_file(old_path.as_ref()).await;
        }
    }
    *guard=Some((id,Arc::clone(&snapshot_path)));
    Ok((id,snapshot_path))
}
fn cleanup_backup_cache(){
    if let Some(cache)=FILE_BACKUP.get(){
        if let Ok(mut guard)=cache.try_lock(){
            if let Some((_,path))=guard.take(){let _=std::fs::remove_file(path.as_ref());}
        }
    }
}
fn browse_backup(snapshot:&std::path::Path,folder:&str,file:Option<&str>)->Result<Value,String>{
    let source=std::fs::File::open(snapshot).map_err(|_|"Cannot open verified snapshot")?;
    let mut archive=zip::ZipArchive::new(source).map_err(|_|"Invalid world snapshot")?;
    if let Some(path)=file{
        if !safe_server_file(path,false){return Err("Protected server file".into())}
        if !["txt","json","yml","yaml","properties","conf","cfg","toml","md","log"]
            .contains(&path.rsplit('.').next().unwrap_or("")){return Err("This file isn't text".into())}
        let f=archive.by_name(path).map_err(|_|"File not found in backup")?;
        if f.size()>TEXT_LIMIT as u64{return Err("File too large to preview".into())}
        let mut content=String::new();
        f.take(TEXT_LIMIT as u64+1).read_to_string(&mut content)
            .map_err(|_|"Unable to read UTF-8 file")?;
        return Ok(json!({"path":path,"content":content,"source":"backup"}))
    }
    let prefix=if folder.is_empty(){String::new()}else{format!("{folder}/")};
    let mut items=std::collections::BTreeMap::<String,Value>::new();
    for i in 0..archive.len(){
        let entry=archive.by_index(i).map_err(|_|"Invalid backup entry")?;
        let name=entry.name().trim_end_matches('/');
        if !name.starts_with(&prefix)||!safe_server_file(name,false){continue}
        let rest=&name[prefix.len()..];
        let first=rest.split('/').next().unwrap_or("");
        if first.is_empty(){continue}
        let path=format!("{prefix}{first}");
        let dir=rest.contains('/')||entry.is_dir();
        items.entry(first.into()).or_insert_with(||
            json!({"name":first,"path":path,"type":if dir{"dir"}else{"file"},
                "size":if dir{Value::Null}else{json!(entry.size())}}));
        if items.len()>=500{break}
    }
    let mut entries=items.into_values().collect::<Vec<_>>();
    entries.sort_by_key(|v|(v["type"].as_str()!=Some("dir"),
        v["name"].as_str().unwrap_or("").to_ascii_lowercase()));
    Ok(json!({"path":folder,"entries":entries,"source":"backup","truncated":entries.len()>=500}))
}
#[tauri::command]
async fn server_files_list(path:String,live:bool)->Result<Value,String>{
    if !safe_server_file(&path,false){return Err("Invalid server directory".into())}
    if live{
        let response=direct_request("command",Some(json!({"type":"files-list","args":{"path":path}}))).await?;
        if response["ok"]!=true{return Err("Server file listing failed".into())}
        let mut result=response["result"].clone();result["source"]=json!("live");
        return Ok(result)
    }
    let (artifact,backup)=verified_backup().await?;
    let path_copy=path.clone();
    let mut result=tokio::task::spawn_blocking(move||browse_backup(backup.as_path(),&path_copy,None))
        .await.map_err(|_|"Backup file index failed")??;
    result["artifactId"]=json!(artifact);
    Ok(result)
}
#[tauri::command]
async fn server_files_read(path:String,live:bool)->Result<Value,String>{
    if !safe_server_file(&path,false){return Err("Protected server file".into())}
    if live{
        let response=direct_request("command",Some(json!({"type":"files-read","args":{"path":path}}))).await?;
        if response["ok"]!=true{return Err("Server file read failed".into())}
        let mut result=response["result"].clone();result["source"]=json!("live");
        return Ok(result)
    }
    let (artifact,backup)=verified_backup().await?;
    let mut result=tokio::task::spawn_blocking(move||browse_backup(backup.as_path(),"",Some(&path)))
        .await.map_err(|_|"Backup read failed")??;
    result["artifactId"]=json!(artifact);
    Ok(result)
}
// Offline player management reveals names and flags only, not UUIDs or
// playerdata. Reading requires the same verified backup as Server Files.
fn permitted_player_name(name:&str)->bool{
    let rest=name.strip_prefix('.').unwrap_or(name);
    let min=if name.starts_with('.') {1}else{3};
    rest.len()>=min&&rest.len()<=16&&rest.bytes().all(|ch|
        ch.is_ascii_alphanumeric()||ch==b'_'
    )
}
fn backup_players(snapshot:&std::path::Path)->Result<Value,String>{
    let file=std::fs::File::open(snapshot).map_err(|_|"Cannot open verified snapshot")?;
    let mut zip=zip::ZipArchive::new(file).map_err(|_|"Invalid verified world archive")?;
    fn names(zip:&mut zip::ZipArchive<std::fs::File>,filename:&str)->Result<Vec<String>,String>{
        let mut found=std::collections::BTreeSet::new();
        if let Ok(mut entry)=zip.by_name(filename){
            if entry.size()>256*1024{return Err("Player record exceeds safe size".into())}
            let mut content=String::new();
            entry.read_to_string(&mut content).map_err(|_|"Cannot decode player record")?;
            let parsed:Value=serde_json::from_str(&content).map_err(|_|"Invalid player record")?;
            let items=parsed.as_array().ok_or("Invalid player record format")?;
            for item in items.iter().take(1000){
                if let Some(name)=item["name"].as_str().filter(|name|permitted_player_name(name)){
                    found.insert(name.to_owned());
                }
            }
        }
        Ok(found.into_iter().collect())
    }
    let whitelisted=names(&mut zip,"whitelist.json")?;
    let operators=names(&mut zip,"ops.json")?;
    let banned=names(&mut zip,"banned-players.json")?;
    let mut whitelist_enabled=Value::Null;
    if let Ok(mut entry)=zip.by_name("server.properties"){
        if entry.size()<=256*1024{
            let mut content=String::new();
            if entry.read_to_string(&mut content).is_ok(){
                for line in content.lines(){
                    if let Some(v)=line.strip_prefix("white-list="){
                        whitelist_enabled=json!(v.trim().eq_ignore_ascii_case("true"));
                    }
                }
            }
        }
    }
    Ok(json!({"online":[],"whitelisted":whitelisted,"operators":operators,
        "banned":banned,"whitelistEnabled":whitelist_enabled,"session":null,"source":"backup"}))
}
#[tauri::command]
async fn server_players_snapshot()->Result<Value,String>{
    let (_,snapshot)=verified_backup().await?;
    tokio::task::spawn_blocking(move||backup_players(snapshot.as_path()))
        .await.map_err(|_|"Cannot inspect verified backup player directory")?
}
// Offline inventory comes from the last SHA-256-verified world backup, never
// guessed from the current Windows app session.
#[tauri::command]
async fn modrinth_installed_inventory(live:bool)->Result<Value,String>{
    if live {
        let response=direct_request("command",
            Some(json!({"type":"marketplace-inventory","args":{}}))).await?;
        if response["ok"]!=true{return Err("Runner could not inspect installed plugins".into())}
        return Ok(response["result"].clone())
    }
    let (_,snapshot)=verified_backup().await?;
    tokio::task::spawn_blocking(move||->Result<Value,String>{
        let file=std::fs::File::open(snapshot.as_ref())
            .map_err(|_|"Cannot open verified world backup")?;
        let mut archive=zip::ZipArchive::new(file).map_err(|_|"Invalid world backup ZIP")?;
        let mut installed=json!({});
        if let Ok(mut entry)=archive.by_name("plugins/.modrinth-installed.json"){
            if entry.size()<=128*1024{
                let mut content=String::new();
                if entry.read_to_string(&mut content).is_ok(){
                    if let Ok(map)=serde_json::from_str::<Value>(&content){
                        if map.is_object(){installed=map;}
                    }
                }
            }
        }
        let mut plugins=Vec::new();
        let mut datapacks=Vec::new();
        for i in 0..archive.len(){
            let entry=archive.by_index(i).map_err(|_|"Invalid archive entry")?;
            let name=entry.name();
            if name.starts_with("plugins/")&&name.ends_with(".jar")
                &&!name[8..].contains('/') {
                plugins.push(name[8..].to_owned());
            }
            if name.starts_with("world/datapacks/")&&name.ends_with(".zip")
                &&!name[16..].contains('/') {
                datapacks.push(name[16..].to_owned());
            }
        }
        Ok(json!({"installed":installed,"pluginFiles":plugins,"datapackFiles":datapacks}))
    }).await.map_err(|_|"Could not read installed marketplace inventory")?
}
#[tauri::command]
async fn server_settings_get()->Result<Value,String>{
    let file=github("/contents/server/server.properties?ref=main",reqwest::Method::GET,None).await?;
    let text=decode_content(&file)?;
    let mut values=serde_json::Map::new();
    for line in text.lines(){
        if line.starts_with('#'){continue;}
        if let Some((k,v))=line.split_once('='){values.insert(k.trim().to_owned(),json!(v.trim()));}
    }
    // Display commonly supported Paper/vanilla options even when the
    // repository currently relies on server defaults. These are UI defaults
    // only; saving one setting must not write the entire list to GitHub.
    let defaults=json!({
        "allow-flight":"false","allow-nether":"true","broadcast-console-to-ops":"true",
        "broadcast-rcon-to-ops":"true","debug":"false","difficulty":"easy",
        "enable-command-block":"false","enable-jmx-monitoring":"false",
        "enable-query":"false","enable-status":"true","enforce-secure-profile":"true",
        "enforce-whitelist":"false","entity-broadcast-range-percentage":"100",
        "force-gamemode":"false","function-permission-level":"2",
        "gamemode":"survival","generate-structures":"true","generator-settings":"{}",
        "hardcore":"false","hide-online-players":"false","level-name":"world",
        "level-seed":"","level-type":"minecraft:normal","log-ips":"true",
        "max-chained-neighbor-updates":"1000000","max-players":"20",
        "max-tick-time":"60000","max-world-size":"29999984","motd":"A Minecraft Server",
        "network-compression-threshold":"256","online-mode":"true",
        "op-permission-level":"4","player-idle-timeout":"0",
        "prevent-proxy-connections":"false","pvp":"true",
        "rate-limit":"0","require-resource-pack":"false","resource-pack":"",
        "resource-pack-prompt":"","resource-pack-sha1":"","server-ip":"",
        "server-port":"25565","simulation-distance":"10","spawn-animals":"true",
        "spawn-monsters":"true","spawn-npcs":"true","spawn-protection":"16",
        "sync-chunk-writes":"true","use-native-transport":"true",
        "view-distance":"10","white-list":"false"
    });
    Ok(json!({"properties":values,"defaults":defaults,"sha":file["sha"]}))
}
#[tauri::command]
async fn server_settings_save(properties:Value,sha:String)->Result<Value,String>{
    let edits=properties.as_object().ok_or("Settings must be an object")?;
    if edits.len()>150||sha.len()!=40{return Err("Invalid settings revision".into())}
    let previous=server_settings_get().await?;
    if previous["sha"].as_str()!=Some(&sha){return Err("Settings changed elsewhere. Reload before saving".into())}
    let mut values=previous["properties"].as_object().ok_or("Invalid settings file")?.clone();
    for (key,value) in edits{
        if key.is_empty()||key.len()>64||!key.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'){
            return Err("Invalid setting name".into())
        }
        let val=match value{
            Value::Bool(b)=>b.to_string(),Value::Number(n)=>n.to_string(),
            Value::String(s)=>s.clone(),_=>return Err(format!("Invalid setting {key}"))
        };
        if val.len()>200||val.contains('\n')||val.contains('\r')||val.contains('\0'){
            return Err(format!("Invalid setting value for {key}"))
        }
        if key=="online-mode" && val!="true"{return Err("Online mode must remain enabled to protect player identities and saved inventories".into())}
        values.insert(key.to_owned(),json!(val));
    }
    values.insert("online-mode".into(),json!("true"));
    let mut output=String::new();
    for (key,value) in values{
        output.push_str(&format!("{key}={}\n",value.as_str().unwrap_or("")));
    }
    github("/contents/server/server.properties",reqwest::Method::PUT,
        Some(json!({"branch":"main","sha":sha,"message":"Update Minecraft server settings from desktop",
        "content":encode_content(&output)}))).await?;
    Ok(json!({"ok":true,"nextSession":true}))
}


const PENDING_MODRINTH:&str="server/pending-modrinth.json";
async fn modrinth_queue_manifest()->Result<(Value,String),String>{
    let file=github(&format!("/contents/{PENDING_MODRINTH}?ref=main"),reqwest::Method::GET,None).await?;
    let value=serde_json::from_str::<Value>(&decode_content(&file)?)
        .map_err(|_|"Invalid pending Modrinth queue")?;
    if !value.is_object(){return Err("Invalid pending Modrinth queue".into())}
    Ok((value,file["sha"].as_str().ok_or("Missing queue revision")?.to_owned()))
}
#[tauri::command]
async fn modrinth_queue_list()->Result<Value,String>{
    Ok(modrinth_queue_manifest().await?.0)
}
#[tauri::command]
async fn modrinth_queue_add(project_id:String,version_id:String,kind:String,title:String)->Result<Value,String>{
    let valid=|id:&str| id.len()>=3&&id.len()<=32&&id.chars().all(|c|c.is_ascii_alphanumeric());
    if !valid(&project_id)||!valid(&version_id)||!["plugin","datapack"].contains(&kind.as_str())
        || title.len()>160||title.chars().any(char::is_control) {
        return Err("Invalid Modrinth installation request".into());
    }
    // Verify the remote project and version before allowing persistent staging.
    let project=http().get(format!("https://api.modrinth.com/v2/project/{project_id}"))
        .send().await.map_err(|_|"Could not verify Modrinth project")?;
    if !project.status().is_success(){return Err("Modrinth project not found".into())}
    let project=project.json::<Value>().await.map_err(|_|"Invalid Modrinth project response")?;
    let version=http().get(format!("https://api.modrinth.com/v2/version/{version_id}"))
        .send().await.map_err(|_|"Could not verify Modrinth release")?;
    if !version.status().is_success(){return Err("Modrinth release not found".into())}
    let release=version.json::<Value>().await.map_err(|_|"Invalid Modrinth release response")?;
    if release["project_id"]!=project["id"]{return Err("Release belongs to a different project".into())}
    let compatible=release["game_versions"].as_array()
        .map(|a|a.iter().any(|v|v.as_str()==Some("26.3"))).unwrap_or(false);
    let loader=release["loaders"].as_array().map(|a|a.iter().any(|v|v.as_str()
        .map(|l|if kind=="plugin"{["paper","spigot","bukkit","purpur"].contains(&l)}else{l=="datapack"})
        .unwrap_or(false))).unwrap_or(false);
    if !compatible||!loader{return Err("This release is not compatible with Paper 26.3".into())}
    if release["dependencies"].as_array().map(|a|a.iter().any(|v|
        v["dependency_type"].as_str()==Some("required"))).unwrap_or(false){
        return Err("Required dependencies are not installed automatically. Install them first.".into())
    }
    let (mut manifest,sha)=modrinth_queue_manifest().await?;
    let map=manifest.as_object_mut().ok_or("Invalid install queue")?;
    if map.len()>=100&&!map.contains_key(&project_id){return Err("Install queue is full".into())}
    map.insert(project_id.clone(),json!({"versionId":version_id,"kind":kind,"title":title}));
    let data=serde_json::to_string_pretty(&manifest).map_err(|_|"Could not encode queued installs")?;
    github(&format!("/contents/{PENDING_MODRINTH}"),reqwest::Method::PUT,Some(json!({
        "branch":"main","sha":sha,
        "message":"Queue Modrinth content for next Paper session",
        "content":encode_content(&(data+"\n"))
    }))).await?;
    Ok(json!({"queued":true,"projectId":project_id,"kind":kind}))
}
#[tauri::command]
async fn modrinth_queue_remove(project_id:String)->Result<Value,String>{
    if project_id.len()<3||project_id.len()>32||!project_id.chars().all(|c|c.is_ascii_alphanumeric()){
        return Err("Invalid Modrinth project".into())
    }
    let (mut manifest,sha)=modrinth_queue_manifest().await?;
    manifest.as_object_mut().ok_or("Invalid queue")?.remove(&project_id);
    let data=serde_json::to_string_pretty(&manifest).map_err(|_|"Could not encode queue")?;
    github(&format!("/contents/{PENDING_MODRINTH}"),reqwest::Method::PUT,Some(json!({
        "branch":"main","sha":sha,
        "message":"Remove pending Modrinth content",
        "content":encode_content(&(data+"\n"))
    }))).await?;
    Ok(json!({"removed":true,"projectId":project_id}))
}


// Desired plugin state is stored separately from version updates. Only
// Modrinth-managed plugin IDs may be enabled/disabled/removed; JARs and
// plugin configuration data are never edited in the public repository.
const PENDING_CONTENT_ACTIONS:&str="server/pending-content-actions.json";
async fn pending_content_actions()->Result<(Value,String),String>{
    let file=github(&format!("/contents/{PENDING_CONTENT_ACTIONS}?ref=main"),
        reqwest::Method::GET,None).await?;
    let value:Value=serde_json::from_str(&decode_content(&file)?)
        .map_err(|_|"Invalid plugin actions manifest")?;
    let map=value.as_object().ok_or("Invalid plugin actions format")?;
    if map.len()>100{return Err("Too many managed plugin changes".into())}
    if map.iter().any(|(id,action)|id.len()<3||id.len()>32||
       !id.chars().all(|c|c.is_ascii_alphanumeric())||
       !["enable","disable","remove"].contains(&action.as_str().unwrap_or(""))){
        return Err("Invalid managed plugin action".into())
    }
    Ok((value,file["sha"].as_str().ok_or("Missing plugin queue revision")?.to_string()))
}
async fn update_content_actions(value:Value,sha:String)->Result<Value,String>{
    let content=serde_json::to_string_pretty(&value).map_err(|_|"Cannot encode plugin queue")?;
    github(&format!("/contents/{PENDING_CONTENT_ACTIONS}"),reqwest::Method::PUT,
        Some(json!({"branch":"main","sha":sha,
            "message":"Update staged Modrinth plugin desired state",
            "content":encode_content(&(content+"\n"))}))).await?;
    Ok(json!({"ok":true}))
}
#[tauri::command]
async fn modrinth_content_actions_list()->Result<Value,String>{
    Ok(pending_content_actions().await?.0)
}
#[tauri::command]
async fn modrinth_content_action_set(project_id:String,action:String)->Result<Value,String>{
    if project_id.len()<3||project_id.len()>32||
       !project_id.chars().all(|c|c.is_ascii_alphanumeric())||
       !["enable","disable","remove"].contains(&action.as_str()){
        return Err("Invalid managed plugin or action".into())
    }
    let (mut value,sha)=pending_content_actions().await?;
    let map=value.as_object_mut().ok_or("Invalid plugin queue")?;
    if map.len()>=100&&!map.contains_key(&project_id){
        return Err("Managed plugin change queue is full".into())
    }
    map.insert(project_id.clone(),json!(action));
    update_content_actions(value,sha).await?;
    Ok(json!({"queued":true,"projectId":project_id,"action":action}))
}
#[tauri::command]
async fn modrinth_content_action_remove(project_id:String)->Result<Value,String>{
    if project_id.len()<3||project_id.len()>32||
       !project_id.chars().all(|c|c.is_ascii_alphanumeric()){
        return Err("Invalid Modrinth project ID".into())
    }
    let (mut value,sha)=pending_content_actions().await?;
    value.as_object_mut().ok_or("Invalid plugin queue")?.remove(&project_id);
    update_content_actions(value,sha).await?;
    Ok(json!({"removed":true,"projectId":project_id}))
}

// Phase 2: a versioned, limited manifest of one-shot file operations.
// A receipt in the verified Paper snapshot prevents repeating a deletion or
// rename every time GitHub Actions starts a new runner.
const STAGED_OPERATIONS:&str="server/pending-operations.json";

fn safe_operation_directory(path:&str)->bool{
    if !valid_path(path) || path.split('/').count()>8{return false;}
    let parts:Vec<String>=path.split('/').map(|s|s.to_ascii_lowercase()).collect();
    if parts.iter().any(|part|part.starts_with('.')||part=="world"
        ||part.starts_with("world_")||
        ["playerdata","stats","advancements","cache","libraries","logs",
         "crash-reports","plugins-disabled","floodgate"].contains(&part.as_str())){return false;}
    if parts[0]=="plugins"&&parts.len()==1{return false;}
    if parts[0]=="plugins"&&parts.iter().skip(1).any(|p|
        p=="geyser-spigot"||p=="floodgate-spigot"){return false;}
    true
}
fn validate_queued_operation(kind:&str,path:&str,target:Option<&str>)->Result<(),String>{
    match kind {
        "mkdir"=>{
            if !safe_operation_directory(path)||target.is_some(){
                return Err("Only safe non-world folders can be queued".into());
            }
        },
        "delete"=>{
            if !safe_server_file(path,true)||target.is_some(){
                return Err("Only safe configuration text files can be deleted".into());
            }
        },
        "rename"=>{
            let target=target.ok_or("Select a new file name")?;
            let source_parent=path.rsplit_once('/').map(|v|v.0).unwrap_or("");
            let target_parent=target.rsplit_once('/').map(|v|v.0).unwrap_or("");
            if !safe_server_file(path,true)||!safe_server_file(target,true)
              ||path==target||source_parent!=target_parent{
                return Err("Only safe text files can be renamed within the same folder".into());
            }
        },
        _=>return Err("Unsupported offline file operation".into())
    }
    Ok(())
}
async fn pending_operations()->Result<(Value,String),String>{
    let file=github(&format!("/contents/{STAGED_OPERATIONS}?ref=main"),
        reqwest::Method::GET,None).await?;
    let value=serde_json::from_str::<Value>(&decode_content(&file)?)
        .map_err(|_|"Invalid queued operation manifest")?;
    if value["version"]!=1||!value["operations"].is_array(){
        return Err("Unsupported queued operation format".into())
    }
    let items=value["operations"].as_array().ok_or("Invalid operation entries")?;
    if items.len()>100{return Err("Too many queued file operations".into())}
    Ok((value,file["sha"].as_str().ok_or("Missing queued operations revision")?.to_owned()))
}
async fn update_operations(value:Value,sha:String,message:&str)->Result<(),String>{
    let payload=serde_json::to_string_pretty(&value).map_err(|_|"Could not serialize operation queue")?;
    if payload.len()>35000{return Err("Operation queue is too large".into())}
    github(&format!("/contents/{STAGED_OPERATIONS}"),reqwest::Method::PUT,
        Some(json!({"branch":"main","sha":sha,"message":message,
        "content":encode_content(&(payload+"\n"))}))).await?;
    Ok(())
}
#[tauri::command]
async fn server_operations_list()->Result<Value,String>{
    Ok(pending_operations().await?.0)
}
#[tauri::command]
async fn server_operations_add(kind:String,path:String,target:Option<String>)->Result<Value,String>{
    validate_queued_operation(&kind,&path,target.as_deref())?;
    let (mut queue,sha)=pending_operations().await?;
    let (edits,_)=pending_files().await?;
    let contents=edits.as_object().ok_or("Invalid staged text queue")?;
    if kind!="mkdir"&&(contents.contains_key(&path)
       ||target.as_ref().is_some_and(|p|contents.contains_key(p))){
        return Err("Discard the queued text edit before changing this file".into())
    }
    let items=queue["operations"].as_array_mut().ok_or("Invalid operation entries")?;
    if items.len()>=100{return Err("Maximum of 100 staged file operations".into())}
    if items.iter().any(|item|
        item["path"].as_str()==Some(path.as_str())||target.as_ref().is_some_and(|p|item["target"].as_str()==Some(p.as_str()))
    ){return Err("A queued file operation already uses this path".into())}
    let nanos=std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_|"System clock unavailable")?.as_nanos();
    let id=format!("op-{:x}-{:x}",std::process::id(),nanos);
    let entry=if let Some(target)=target{
        json!({"id":id,"type":kind,"path":path,"target":target})
    }else{
        json!({"id":id,"type":kind,"path":path})
    };
    items.push(entry.clone());
    update_operations(queue,sha,"Queue safe server file operation for next Paper session").await?;
    Ok(entry)
}
#[tauri::command]
async fn server_operations_remove(id:String)->Result<Value,String>{
    if id.len()<12||id.len()>80||!id.chars().all(|c|
        c.is_ascii_lowercase()||c.is_ascii_digit()||c=='-'){
        return Err("Invalid queued operation ID".into())
    }
    let (mut queue,sha)=pending_operations().await?;
    let items=queue["operations"].as_array_mut().ok_or("Invalid operations queue")?;
    let before=items.len();
    items.retain(|item|item["id"]!=id);
    if items.len()==before{return Err("Queued operation already removed".into())}
    update_operations(queue,sha,"Discard queued server file operation").await?;
    Ok(json!({"removed":true,"id":id}))
}
// A unified queue includes file edits, one-shot operations, and Modrinth
// installs. It reports only validated names and version metadata, not text
// contents or private player data.
#[tauri::command]
async fn server_change_queue()->Result<Value,String>{
    let (edits,operations,plugins)=tokio::try_join!(
        pending_files(),pending_operations(),modrinth_queue_manifest()
    )?;
    let mut items=Vec::<Value>::new();
    if let Some(map)=edits.0.as_object(){
        for (path,content) in map {
            if !safe_server_file(path,true){continue;}
            let digest=format!("{:x}",Sha256::digest(content.as_str().unwrap_or("").as_bytes()));
            items.push(json!({"kind":"edit","id":path,"path":path,"hash":digest}));
        }
    }
    if let Some(ops)=operations.0["operations"].as_array(){
        for op in ops {
            let kind=op["type"].as_str().unwrap_or("");
            let path=op["path"].as_str().unwrap_or("");
            if validate_queued_operation(kind,path,op["target"].as_str()).is_ok(){
                items.push(json!({"kind":kind,"id":op["id"],
                    "path":path,"target":op["target"]}));
            }
        }
    }
    if let Some(map)=plugins.0.as_object(){
        for (id,record) in map{
            let kind=record["kind"].as_str().unwrap_or("");
            if ["plugin","datapack"].contains(&kind){
                items.push(json!({"kind":kind,"id":id,
                    "title":record["title"],"versionId":record["versionId"]}));
            }
        }
    }
    Ok(json!({"items":items,"count":items.len()}))
}
fn backup_queue_receipts(snapshot:&std::path::Path)->Result<Value,String>{
    let file=std::fs::File::open(snapshot).map_err(|_|"Cannot open verified backup")?;
    let mut zip=zip::ZipArchive::new(file).map_err(|_|"Invalid verified backup")?;
    let mut result=json!({"operations":{},"edits":{},"installed":{}});
    for (name,key) in [
        (".cloud-applied-ops.json","operations"),
        (".cloud-applied-edits.json","edits"),
        ("plugins/.modrinth-installed.json","installed")
    ]{
        if let Ok(mut entry)=zip.by_name(name){
            if entry.size()>131072{continue;}
            let mut content=String::new();
            if entry.read_to_string(&mut content).is_ok(){
                if let Ok(value)=serde_json::from_str::<Value>(&content){
                    if value.is_object(){result[key]=value;}
                }
            }
        }
    }
    Ok(result)
}
#[tauri::command]
async fn server_change_receipts(live:bool,running:bool)->Result<Value,String>{
    if live{
        let response=direct_request("command",
            Some(json!({"type":"file-queue-receipts","args":{}}))).await?;
        if response["ok"]!=true{return Err("Could not read applied queue status".into())}
        return Ok(response["result"].clone())
    }
    if running{return Err("The live server is unreachable. Applied status is unknown until its next verified backup.".into())}
    let (_,backup)=verified_backup().await?;
    tokio::task::spawn_blocking(move||backup_queue_receipts(backup.as_path()))
        .await.map_err(|_|"Backup queue status could not be read")?
}
