#![recursion_limit = "512"]
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use tauri::{Manager, Emitter};


include!("server_files.rs");

const REPO: &str = "majoodsaod-spec/minecraft-cloud-control";
const SERVER_WORKFLOW: &str = "paper-state-test.yml";
const GITHUB_SECRET: &str = "github-token";
const CF_URL: &str = "cloudflare-url";
const CF_PASSWORD: &str = "cloudflare-password";
static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn http() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| reqwest::Client::builder()
        .user_agent("MinecraftCloudDesktop/0.1")
        .timeout(std::time::Duration::from_secs(35))
        .build().expect("reqwest client"))
}
fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("Minecraft Cloud Desktop", name).map_err(|_| "Windows credential storage unavailable".to_owned())
}
fn secret(name: &str) -> Result<String, String> {
    entry(name)?.get_password().map_err(|_| format!("{} is not configured", name))
}
fn save_secret(name: &str, value: &str) -> Result<(), String> {
    entry(name)?.set_password(value).map_err(|_| "Couldn't securely save credentials".to_owned())
}
fn remove_secret(name: &str) -> Result<(), String> {
    match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Couldn't remove Windows credential".to_owned())
    }
}
async fn github(path: &str, method: reqwest::Method, body: Option<Value>) -> Result<Value, String> {
    let token = secret(GITHUB_SECRET)?;
    let mut req = http().request(method, format!("https://api.github.com/repos/{REPO}{path}"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(body) = body { req = req.json(&body); }
    let response = req.send().await.map_err(|_| "Couldn't reach GitHub. Check your internet connection.".to_owned())?;
    let code = response.status();
    if code == reqwest::StatusCode::NO_CONTENT { return Ok(json!({"ok":true})); }
    let text = response.text().await.map_err(|_| "Invalid GitHub response".to_owned())?;
    if !code.is_success() {
        let message = serde_json::from_str::<Value>(&text).ok()
            .and_then(|v| v["message"].as_str().map(str::to_owned))
            .unwrap_or_else(|| "GitHub request failed".to_owned());
        return Err(format!("GitHub {}: {}", code.as_u16(), message.chars().take(180).collect::<String>()));
    }
    serde_json::from_str(&text).map_err(|_| "Couldn't parse GitHub response".to_owned())
}
#[tauri::command]
async fn connect_github(token: String) -> Result<Value, String> {
    let token=token.trim();
    if token.is_empty() || token.len()>512 { return Err("Enter a valid GitHub token".into()); }
    save_secret(GITHUB_SECRET,token)?;
    match github("",reqwest::Method::GET,None).await {
        Ok(repo) => Ok(json!({"connected":true,"repository":repo["full_name"],"private":repo["private"]})),
        Err(e) => { let _=remove_secret(GITHUB_SECRET); Err(e) }
    }
}
#[tauri::command]
fn disconnect_github() -> Result<(), String> { remove_secret(GITHUB_SECRET) }
#[tauri::command]
async fn github_status() -> Value {
    match github("", reqwest::Method::GET, None).await {
        Ok(repo)=>json!({"connected":true,"repository":repo["full_name"]}),
        Err(err)=>json!({"connected":false,"error":err})
    }
}
#[tauri::command]
async fn github_overview() -> Result<Value, String> {
    let (runs,artifacts,repo)=tokio::join!(
        github("/actions/runs?per_page=35",reqwest::Method::GET,None),
        github("/actions/artifacts?name=minecraft-world&per_page=30",reqwest::Method::GET,None),
        github("",reqwest::Method::GET,None)
    );
    let runs = runs?;
    let artifacts = artifacts?;
    let repo = repo?;
    Ok(json!({"runs":runs["workflow_runs"],"artifacts":artifacts["artifacts"],
        "repository":repo["full_name"]}))
}
#[tauri::command]
async fn github_workflows() -> Result<Value, String> {
    Ok(github("/actions/workflows?per_page=100",reqwest::Method::GET,None).await?["workflows"].clone())
}
#[tauri::command]
async fn github_runs(workflow_id: String) -> Result<Value, String> {
    if !workflow_id.chars().all(|ch|ch.is_ascii_alphanumeric()||ch=='-'||ch=='_'||ch=='.')
        || workflow_id.len()>100 { return Err("Invalid workflow identifier".into()); }
    Ok(github(&format!("/actions/workflows/{workflow_id}/runs?per_page=30"),reqwest::Method::GET,None).await?["workflow_runs"].clone())
}
#[tauri::command]
async fn github_dispatch(workflow_id: String) -> Result<Value, String> {
    const ALLOWED: &[&str]=&[
        "paper-state-test.yml","dashboard-checks.yml","maintenance-log.yml"
    ];
    if !ALLOWED.contains(&workflow_id.as_str()) { return Err("That workflow cannot be started from the app".into()); }
    if workflow_id == SERVER_WORKFLOW {
        let runs=github(&format!("/actions/workflows/{SERVER_WORKFLOW}/runs?per_page=30"),
            reqwest::Method::GET,None).await?;
        let active=runs["workflow_runs"].as_array().map(|items|items.iter().any(|r|
            ["in_progress","queued","waiting","requested","pending"].contains(
                &r["status"].as_str().unwrap_or("")))).unwrap_or(false);
        if active { return Err("The Minecraft server already has an active GitHub Actions run; no duplicate was started".into()); }
    }
    github(&format!("/actions/workflows/{workflow_id}/dispatches"),reqwest::Method::POST,
           Some(json!({"ref":"main"}))).await
}
#[tauri::command]
async fn github_cancel(run_id: u64) -> Result<Value, String> {
    let run=github(&format!("/actions/runs/{run_id}"),reqwest::Method::GET,None).await?;
    if run["name"].as_str().unwrap_or("").contains("Continuous Paper Minecraft Server")
        || run["path"].as_str().unwrap_or("").contains(SERVER_WORKFLOW)
        || run["workflow_id"].is_null() {
        return Err("Minecraft runs cannot be force-cancelled: that would skip the world save and backup. Use Safe Save & Stop when the live bridge is online.".into());
    }
    github(&format!("/actions/runs/{run_id}/cancel"),reqwest::Method::POST,None).await
}
#[tauri::command]
async fn github_jobs(run_id: u64) -> Result<Value, String> {
    Ok(github(&format!("/actions/runs/{run_id}/jobs?per_page=100"),reqwest::Method::GET,None).await?["jobs"].clone())
}
#[tauri::command]
async fn github_job_log(job_id: u64) -> Result<String, String> {
    let token=secret(GITHUB_SECRET)?;
    let url=format!("https://api.github.com/repos/{REPO}/actions/jobs/{job_id}/logs");
    let response=http().get(url).bearer_auth(token)
        .header("Accept","application/vnd.github+json").send().await
        .map_err(|_|"Couldn't retrieve GitHub Actions job logs".to_owned())?;
    if !response.status().is_success() {
        return Err(format!("GitHub couldn't retrieve job logs (HTTP {})",response.status().as_u16()));
    }
    let mut stream=response.bytes_stream();
    let mut tail=Vec::new();
    while let Some(part)=stream.next().await {
        let chunk=part.map_err(|_|"Job log download interrupted")?;
        tail.extend_from_slice(&chunk);
        // Keep only a bounded tail rather than downloading a giant
        // multi-hour Minecraft log into the lightweight desktop window.
        if tail.len()>512_000 {
            let excess=tail.len()-512_000;
            tail.drain(..excess);
        }
    }
    let output=String::from_utf8_lossy(&tail);
    Ok(output.lines().rev().take(160).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"))
}
#[tauri::command]
async fn github_file(path: String) -> Result<Value, String> {
    if !valid_path(&path) { return Err("Invalid repository file path".into()); }
    let encoded=path.split('/').map(urlencoding::encode).map(|s|s.to_string()).collect::<Vec<_>>().join("/");
    github(&format!("/contents/{encoded}?ref=main"),reqwest::Method::GET,None).await
}
fn valid_path(path: &str) -> bool {
    !path.is_empty() && path.len()<180 && !path.starts_with('/')
      && path.split('/').all(|part|!part.is_empty()&&part!="."&&part!=".."
       &&part.chars().all(|ch|ch.is_ascii_alphanumeric()||"._-".contains(ch)))
}
#[derive(Deserialize)]
struct RepoWrite { path: String, sha: String, content_base64: String, message: String }
#[tauri::command]
async fn github_save_file(args: RepoWrite) -> Result<Value, String> {
    if !valid_path(&args.path) || args.content_base64.len()>650000 || args.message.len()>120
        || args.message.is_empty() || args.sha.len()!=40 {
        return Err("Invalid repository update".into());
    }
    let encoded=args.path.split('/').map(urlencoding::encode).map(|s|s.to_string()).collect::<Vec<_>>().join("/");
    github(&format!("/contents/{encoded}"),reqwest::Method::PUT,
        Some(json!({"branch":"main","message":args.message,"content":args.content_base64,"sha":args.sha}))).await
}
// An update reuses the existing GitHub-built NSIS installer. It upgrades
// the current Windows installation; users don't extract artifact ZIPs by hand.
// Builds are limited to successfully completed main-branch workflow runs.
const INSTALLER_WORKFLOW: &str = "build-windows.yml";
const INSTALLER_ARTIFACT: &str = "Minecraft-Cloud-Windows-Installer";
const DOWNLOAD_LIMIT: u64 = 250 * 1024 * 1024;

fn installed_build() -> u64 {
    option_env!("MC_DESKTOP_BUILD_RUN_ID").unwrap_or("0").parse().unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheck {
    available: bool,
    current_build: u64,
    latest_build: u64,
    run_number: u64,
    commit: String,
    artifact_id: u64,
    latest_attempt_number: u64,
    latest_attempt_status: String,
}

async fn current_update() -> Result<UpdateCheck, String> {
    // GitHub returns newest first. Never offer unfinished, failing, or
    // arbitrary-branch artifacts as application updates.
    let path=format!("/actions/workflows/{INSTALLER_WORKFLOW}/runs?branch=main&status=success&per_page=12");
    let runs=github(&path, reqwest::Method::GET, None).await?;
    // Keep failed, cancelled and in-progress attempts visible to users:
    // otherwise the updater misleadingly claims there is nothing new.
    let latest_attempt=github(&format!("/actions/workflows/{INSTALLER_WORKFLOW}/runs?branch=main&per_page=1"),
        reqwest::Method::GET,None).await.unwrap_or(json!({}));
    let attempt=latest_attempt["workflow_runs"].as_array().and_then(|list|list.first());
    let latest_attempt_number=attempt.and_then(|run|run["run_number"].as_u64()).unwrap_or(0);
    let latest_attempt_status=attempt.map(|run| {
        if run["status"].as_str()==Some("completed") {
            run["conclusion"].as_str().unwrap_or("unknown")
        } else {
            run["status"].as_str().unwrap_or("unknown")
        }
    }).unwrap_or("unknown").to_owned();
    let candidates=runs["workflow_runs"].as_array()
        .ok_or("GitHub did not return a list of installer builds")?;
    for run in candidates {
        if run["status"].as_str()!=Some("completed")
            || run["conclusion"].as_str()!=Some("success")
            || run["head_branch"].as_str()!=Some("main") {
            continue;
        }
        let run_id=run["id"].as_u64().unwrap_or(0);
        if run_id==0 {continue;}
        let artifacts=github(&format!("/actions/runs/{run_id}/artifacts?per_page=100"),
            reqwest::Method::GET, None).await?;
        let artifact=artifacts["artifacts"].as_array().and_then(|items| items.iter().find(|a|
            a["name"].as_str()==Some(INSTALLER_ARTIFACT)
            && a["expired"].as_bool()==Some(false)
            && a["size_in_bytes"].as_u64().unwrap_or(u64::MAX)<DOWNLOAD_LIMIT
        ));
        if let Some(artifact)=artifact {
            let artifact_id=artifact["id"].as_u64().unwrap_or(0);
            if artifact_id==0 {continue;}
            return Ok(UpdateCheck {
                available:run_id>installed_build(),
                current_build:installed_build(),latest_build:run_id,
                run_number:run["run_number"].as_u64().unwrap_or(0),
                commit:run["head_sha"].as_str().unwrap_or("").chars().take(12).collect(),
                artifact_id,latest_attempt_number,latest_attempt_status,
            });
        }
    }
    Err("No successful Windows installer artifact is available yet. Check the GitHub Actions installer workflow.".into())
}

#[tauri::command]
async fn desktop_check_update() -> Result<UpdateCheck, String> {
    current_update().await
}

#[tauri::command]
async fn desktop_install_update(app: tauri::AppHandle, expected_build: u64) -> Result<(), String> {
    // Recheck immediately before downloading, so callers cannot inject an
    // arbitrary artifact ID and install an unrelated executable.
    let update=current_update().await?;
    if !update.available || update.latest_build!=expected_build {
        return Err("That update is no longer current. Check for updates again.".into());
    }
    let token=secret(GITHUB_SECRET)?;
    let url=format!("https://api.github.com/repos/{REPO}/actions/artifacts/{}/zip",update.artifact_id);
    let response=http().get(url).bearer_auth(token)
        .header("Accept","application/vnd.github+json").send().await
        .map_err(|_|"Couldn't download the Windows update from GitHub".to_owned())?;
    if !response.status().is_success() {
        return Err(format!("Windows update download failed (HTTP {})",response.status().as_u16()));
    }
    if response.content_length().unwrap_or(0)>DOWNLOAD_LIMIT {
        return Err("Update exceeds the download safety limit".into());
    }
    let dir=std::env::temp_dir().join("MinecraftCloudUpdates").join(update.latest_build.to_string());
    tokio::fs::create_dir_all(&dir).await
        .map_err(|_|"Couldn't create a temporary update directory")?;
    let zip_file=dir.join("installer.zip");
    let mut output=tokio::fs::File::create(&zip_file).await
        .map_err(|_|"Couldn't write the downloaded update")?;
    use tokio::io::AsyncWriteExt;
    let expected_size=response.content_length().filter(|size| *size>0);
    let mut stream=response.bytes_stream();
    let mut total=0_u64;
    while let Some(next)=stream.next().await {
        let chunk=next.map_err(|_|"The update download was interrupted")?;
        total+=chunk.len() as u64;
        let percent=expected_size.map(|size| (total.saturating_mul(100)/size).min(100));
        let _=app.emit("desktop-update-progress",json!({"stage":"downloading","percent":percent}));
        if total>DOWNLOAD_LIMIT {
            let _=tokio::fs::remove_file(&zip_file).await;
            return Err("Update exceeds the download safety limit".into());
        }
        output.write_all(&chunk).await.map_err(|_|"Couldn't save the update")?;
    }
    output.flush().await.map_err(|_|"Couldn't finish the update download")?;
    drop(output);

    let _=app.emit("desktop-update-progress",json!({"stage":"extracting"}));
    // Extract only a filename-matched installer, never arbitrary ZIP paths.
    // The ZIP comes from the latest successful workflow in our own repository.
    let installer=dir.join("MinecraftCloud-Update-Setup.exe");
    let zip_source=zip_file.clone();
    let dest=installer.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let file=std::fs::File::open(&zip_source).map_err(|_|"Couldn't open the downloaded ZIP")?;
        let mut archive=zip::ZipArchive::new(file).map_err(|_|"Invalid installer artifact ZIP")?;
        let mut matched=0;
        for i in 0..archive.len() {
            let mut entry=archive.by_index(i).map_err(|_|"Couldn't read update ZIP")?;
            let path=std::path::Path::new(entry.name());
            // GitHub artifact ZIP entries should contain a single NSIS setup
            // executable at the root, never an arbitrary nested path.
            let basename=path.file_name().and_then(|n|n.to_str()).unwrap_or("");
            if path.components().count()!=1 || !basename.ends_with("-setup.exe") {continue;}
            if entry.size()>DOWNLOAD_LIMIT {return Err("Installer is unexpectedly large".into());}
            matched+=1;
            if matched>1 {return Err("Artifact contains multiple installers".into());}
            let mut dst=std::fs::File::create(&dest).map_err(|_|"Can't extract setup executable")?;
            std::io::copy(&mut entry,&mut dst).map_err(|_|"Installer extraction failed")?;
        }
        if matched!=1 {return Err("No Windows NSIS setup executable in the artifact".into());}
        Ok(())
    }).await.map_err(|_|"Update extraction failed")??;

    // This is an in-place NSIS upgrade for the same Tauri app identifier.
    // Launch first, then close our own process so Windows can replace files.
    let _=app.emit("desktop-update-progress",json!({"stage":"launching"}));
    std::process::Command::new(installer)
        .spawn().map_err(|_|"Windows couldn't launch the update installer")?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn github_download_backup(artifact_id: u64) -> Result<String, String> {
    let token=secret(GITHUB_SECRET)?;
    let url=format!("https://api.github.com/repos/{REPO}/actions/artifacts/{artifact_id}/zip");
    let response=http().get(url).bearer_auth(token)
        .header("Accept","application/vnd.github+json").send().await
        .map_err(|_|"Backup download could not start".to_owned())?;
    if !response.status().is_success() {
        return Err(format!("GitHub couldn't download this artifact (HTTP {})",response.status().as_u16()));
    }
    let folder=dirs::download_dir().ok_or("Windows Downloads folder not found")?;
    let path=folder.join(format!("minecraft-world-{artifact_id}.zip"));
    let mut file=tokio::fs::File::create(&path).await.map_err(|_|"Can't create backup file".to_owned())?;
    use tokio::io::AsyncWriteExt;
    let mut stream=response.bytes_stream();
    while let Some(chunk)=stream.next().await {
        file.write_all(&chunk.map_err(|_|"Backup download interrupted")?)
            .await.map_err(|_|"Couldn't write backup file")?;
    }
    file.flush().await.map_err(|_|"Couldn't finish writing backup")?;
    Ok(path.to_string_lossy().into_owned())
}
fn cf_url() -> Result<String,String> {
    let url=secret(CF_URL)?;
    if !url.starts_with("https://") || url.contains('?') || url.contains('#') {
        return Err("Cloudflare URL must be HTTPS with no query string".into());
    }
    Ok(url.trim_end_matches('/').to_owned())
}
#[tauri::command]
fn configure_cloudflare(url:String,password:String)->Result<(),String> {
    let url=url.trim().trim_end_matches('/');
    if !url.starts_with("https://") || url.len()>250 || url.contains('?') || url.contains('#')
        || password.is_empty() {return Err("Enter your HTTPS Cloudflare dashboard URL and password".into());}
    save_secret(CF_URL,url)?;
    save_secret(CF_PASSWORD,&password)
}
#[tauri::command]
async fn cloudflare_status()->Result<Value,String> {
    let url=cf_url()?;
    let pass=secret(CF_PASSWORD)?;
    let resp=http().get(format!("{url}/api/control?action=live"))
      .header("X-Admin-Password",pass).send().await
      .map_err(|_|"Cloudflare is unreachable".to_owned())?;
    if !resp.status().is_success(){return Err(format!("Cloudflare live bridge HTTP {}",resp.status().as_u16()));}
    resp.json().await.map_err(|_|"Invalid Cloudflare response".into())
}
#[tauri::command]
async fn cloudflare_command(kind:String)->Result<Value,String> {
    if kind!="restart" && kind!="save" && kind!="shutdown" {
        return Err("Unsupported live operation".into());
    }
    let url=cf_url()?;let pass=secret(CF_PASSWORD)?;
    let response=http().post(format!("{url}/api/control?action=live-command"))
      .header("X-Admin-Password",pass).json(&json!({"type":kind,"args":{}}))
      .send().await.map_err(|_|"Cloudflare control request failed".to_owned())?;
    if !response.status().is_success(){return Err(format!("Live control HTTP {}",response.status().as_u16()));}
    response.json().await.map_err(|_|"Invalid control reply".into())
}
async fn dashboard_power_action(action:&str,run_id:Option<u64>)->Result<Value,String>{
    let url=cf_url()?;let pass=secret(CF_PASSWORD)?;
    let mut body=json!({});
    if let Some(run)=run_id{body["run_id"]=json!(run)}
    let response=http().post(format!("{url}/api/control?action={action}"))
        .header("X-Admin-Password",pass).json(&body).send().await
        .map_err(|_|"Dashboard unavailable. Automatic restore requires a configured Cloudflare connection".to_owned())?;
    let code=response.status();
    let result=response.json::<Value>().await.map_err(|_|"Invalid dashboard restore response")?;
    if !code.is_success(){return Err(format!("Restore request rejected (HTTP {}): {}",
        code.as_u16(),result["error"].as_str().unwrap_or("Unknown error")))}
    Ok(result)
}
#[tauri::command]
async fn server_restore_backup(app:tauri::AppHandle,run_id:u64)->Result<Value,String>{
    if run_id==0{return Err("Select a valid backup".into())}
    // Verify the snapshot before modifying power state.
    let artifacts=github("/actions/artifacts?name=minecraft-world&per_page=100",
        reqwest::Method::GET,None).await?;
    let valid=artifacts["artifacts"].as_array().map(|a|a.iter().any(|v|
        v["name"]=="minecraft-world"&&v["expired"]==false&&
        v["workflow_run"]["id"].as_u64()==Some(run_id))).unwrap_or(false);
    if !valid{return Err("Selected world backup is expired or unavailable".into())}
    let runs=github(&format!("/actions/workflows/{SERVER_WORKFLOW}/runs?per_page=30"),
        reqwest::Method::GET,None).await?;
    let active=runs["workflow_runs"].as_array()
        .map(|a|a.iter().filter(|r|["in_progress","queued","waiting","pending","requested"]
        .contains(&r["status"].as_str().unwrap_or("")))
        .filter_map(|r|r["id"].as_u64()).collect::<Vec<_>>())
        .unwrap_or_default();
    if !active.is_empty(){
        let _=app.emit("server-restore-progress",json!({"stage":"saving",
            "message":"Saving current world and stopping Paper before restore…"}));
        dashboard_power_action("stop",None).await?;
        let started=std::time::Instant::now();
        loop{
            if started.elapsed()>std::time::Duration::from_secs(540){
                return Err("The safe shutdown has not finished. No restore was started. Check the world backup workflow.".into())
            }
            tokio::time::sleep(std::time::Duration::from_secs(7)).await;
            let latest=github(&format!("/actions/workflows/{SERVER_WORKFLOW}/runs?per_page=30"),
                reqwest::Method::GET,None).await?;
            let pending=latest["workflow_runs"].as_array().map(|items|
                items.iter().any(|r|["in_progress","queued","waiting","pending","requested"]
                .contains(&r["status"].as_str().unwrap_or("")))).unwrap_or(true);
            if pending{continue}
            let failed=active.iter().any(|id|latest["workflow_runs"].as_array().map(|items|
                items.iter().any(|r|r["id"].as_u64()==Some(*id)&&r["conclusion"]!="success"))
                .unwrap_or(true));
            if failed{
                return Err("Server shutdown did not complete successfully. World restore aborted to protect the saved world.".into())
            }
            break;
        }
    }
    let _=app.emit("server-restore-progress",json!({"stage":"restoring",
        "message":"Starting Paper from the selected verified world backup…"}));
    let result=dashboard_power_action("restore",Some(run_id)).await?;
    let _=app.emit("server-restore-progress",json!({"stage":"requested",
        "message":"World restore requested. Watch the new GitHub runner startup."}));
    Ok(result)
}
#[tauri::command]
async fn cloudflare_console(command:String)->Result<Value,String> {
    if command.is_empty()||command.len()>240||command.contains('\n')||command.contains('\r'){
        return Err("Invalid console command".into());
    }
    let url=cf_url()?;let pass=secret(CF_PASSWORD)?;
    let response=http().post(format!("{url}/api/control?action=live-command"))
      .header("X-Admin-Password",pass).json(&json!({"type":"console","args":{"command":command}}))
      .send().await.map_err(|_|"Cloudflare control request failed".to_owned())?;
    if !response.status().is_success(){return Err(format!("Live console HTTP {}",response.status().as_u16()));}
    response.json().await.map_err(|_|"Invalid console reply".into())
}
// NetBird is a system-wide VPN. Automatic connection is opt-in and this
// process only disconnects a connection it started itself. Never shut down a
// VPN session that was already active when Minecraft Cloud opened.
const AUTO_NETBIRD: &str = "auto-netbird-on-open";
#[derive(Default)]
struct NetbirdOwnership { connected_by_app: bool }

// The GUI must never pop visible CLI windows during background polling.
#[cfg(windows)]
fn hide_netbird_console(command: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
}
#[cfg(not(windows))]
fn hide_netbird_console(command: &mut std::process::Command) -> &mut std::process::Command {
    command
}
fn netbird_binary() -> Result<std::path::PathBuf, String> {
    let candidates=[
        std::path::PathBuf::from(r"C:\Program Files\NetBird\netbird.exe"),
        std::path::PathBuf::from(r"C:\Program Files\NetBird\bin\netbird.exe"),
        std::path::PathBuf::from(r"C:\Program Files (x86)\NetBird\netbird.exe"),
        std::path::PathBuf::from("netbird"),
    ];
    for path in candidates {
        if hide_netbird_console(std::process::Command::new(&path).arg("version"))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status().map(|s|s.success()).unwrap_or(false) {
            return Ok(path);
        }
    }
    Err("NetBird CLI wasn't found. Install and sign in to NetBird first.".into())
}

fn netbird_cli(exe: &std::path::Path, operation: &str) -> Result<String, String> {
    netbird_cli_args(exe,&[operation])
}
fn netbird_cli_args(exe: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let operation=args.join(" ");
    let mut child=hide_netbird_console(std::process::Command::new(exe).args(args))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn().map_err(|_|"Unable to run NetBird client".to_owned())?;
    for _ in 0..150 {
        match child.try_wait() {
            Ok(Some(_)) => {
                let result=child.wait_with_output().map_err(|_|"NetBird command could not finish")?;
                if !result.status.success() {return Err(format!("NetBird {operation} failed. Check Windows permissions or open the NetBird app."));}
                return Ok(String::from_utf8_lossy(&result.stdout).into_owned());
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(_) => return Err("Unable to read NetBird status".into()),
        }
    }
    let _=child.kill();let _=child.wait();
    Err(format!("NetBird {operation} timed out; check the NetBird app"))
}

#[cfg(test)]
mod netbird_lifecycle_tests {
    use super::*;
    #[test]
    fn only_explicitly_connected_status_counts() {
        assert!(netbird_is_connected("Management: Connected\nSignal: Connected\n"));
        assert!(netbird_is_connected("Management: Connected to https://api.netbird.io:443\nSignal: Connected to https://signal.netbird.io:443\n"));
        assert!(!netbird_is_connected("Management: Disconnected\nSignal: Connected\n"));
        assert!(!netbird_is_connected("Management: Connected\nSignal: Disconnected\n"));
        assert!(!netbird_is_connected("Peers count: 1/2 Connected\n"));
    }
    #[test]
    fn discovers_runner_from_netbird_table_and_details() {
        assert_eq!(runner_peer_id("minecraft-paper-42389453154.netbird.cloud"),Some(42389453154));
        assert_eq!(runner_peer_id("minecraft-paper-42389453154"),Some(42389453154));
        assert_eq!(runner_peer_id("minecraft-paper-42396124824-29-165.netbird.cloud"),Some(42396124824));
        assert_eq!(runner_peer_id("minecraft-paper-42394763848-93-185.netbird.cloud"),Some(42394763848));
        assert_eq!(runner_peer_id("minecraft-paper-42396124824-other.netbird.cloud"),None);
        assert_eq!(runner_peer_id("minecraft-paper-42396124824-29-nope.netbird.cloud"),None);
        assert_eq!(parse_peer_table("NAME IP STATUS CONN\nminecraft-paper-42389453154.netbird.cloud 100.94.2.7 Connected Relayed\n"),
            Some("100.94.2.7".to_owned()));
        assert_eq!(parse_peer_table("NAME IP STATUS CONN\nminecraft-paper-42389453154 100.94.2.7 Idle -\n"),
            Some("100.94.2.7".to_owned()));
        assert_eq!(parse_peer_table("NAME IP STATUS CONN\nminecraft-paper-42389453154 100.94.2.7 Connecting -\n"),
            Some("100.94.2.7".to_owned()));
        assert_eq!(parse_peer_details("Peers detail:\n minecraft-paper-42389453154.netbird.cloud:\n  NetBird IP: 100.94.2.7\n  Status: Idle\n"),
            Some("100.94.2.7".to_owned()));
        assert_eq!(parse_peer_details("Peers detail:\n minecraft-paper-42389453154.netbird.cloud:\n  NetBird IP: 100.94.2.7\n  Status: Connected\n"),
            Some("100.94.2.7".to_owned()));
        // Windows NetBird 0.82 appends the last two IPv4 octets to peer names.
        assert_eq!(parse_peer_details("minecraft-paper-42396124824-29-165.netbird.cloud:\n  NetBird IP: 100.93.29.165\n  Status: Idle\n\n minecraft-paper-42394763848-93-185.netbird.cloud:\n  NetBird IP: 100.93.93.185\n  Status: Idle\n"),
            Some("100.93.29.165".to_owned()));
        assert_eq!(parse_peer_table("NAME IP STATUS CONN\nminecraft-paper-42396124824-29-165.netbird.cloud 100.93.29.165 Idle -\n"),
            Some("100.93.29.165".to_owned()));
    }
    #[test]
    fn discovers_runner_from_netbird_json() {
        let report=r#"{
          "daemonStatus":"Connected",
          "peers":{"total":2,"connected":1,"details":[
            {"fqdn":"minecraft-paper-42389453153.netbird.cloud","netbirdIp":"100.94.2.4","status":"Connected"},
            {"fqdn":"minecraft-paper-42389453154.netbird.cloud","netbirdIp":"100.94.2.7","status":"Idle"}
          ]}
        }"#;
        assert_eq!(parse_peer_json(report),Some("100.94.2.7".into()));
        assert_eq!(parse_peer_json(r#"{"peers":{"details":[
          {"fqdn":"minecraft-paper-42394763848-93-185.netbird.cloud","netbirdIp":"100.93.93.185","status":"Idle"},
          {"fqdn":"minecraft-paper-42396124824-29-165.netbird.cloud","netbirdIp":"100.93.29.165","status":"Idle"}
        ]}}"#),Some("100.93.29.165".into()));
        assert_eq!(parse_peer_json(r#"{"peers":{"details":[
          {"fqdn":"minecraft-paper-42389453154.netbird.cloud",
           "netbirdIp":"100.94.2.7","status":"Disconnected"}
        ]}}"#),None);
        assert_eq!(parse_peer_json("{}"),None);
        assert_eq!(parse_peer_json(r#"{"peers":{"details":[{"fqdn":"minecraft-paper-2",
            "netbirdIp":"8.8.8.8","status":"Connected"}]}}"#),None);
    }
    #[test]
    fn manual_overlay_address_cannot_point_to_public_internet() {
        assert!(private_overlay_ip("100.93.164.78"));
        assert!(!private_overlay_ip("127.0.0.1"));
        assert!(!private_overlay_ip("8.8.8.8"));
        assert!(!private_overlay_ip("192.168.1.20"));
    }
}

fn netbird_is_connected(output: &str) -> bool {
    let has=|key: &str| output.lines().any(|line| {
        let trimmed=line.trim();
        trimmed.to_ascii_lowercase().starts_with(key)
            && trimmed.split_once(':').map(|(_,v)|v.trim().to_ascii_lowercase().starts_with("connected")).unwrap_or(false)
    });
    has("management:") && has("signal:")
}

fn auto_netbird_enabled() -> bool {
    secret(AUTO_NETBIRD).map(|s|s=="on").unwrap_or(false)
}

fn connect_netbird_if_needed(ownership: &Mutex<NetbirdOwnership>) -> Result<bool, String> {
    // Serialize startup and shutdown: otherwise closing the GUI while
    // "netbird up" is finishing could leave the system-wide VPN connected.
    let mut state=ownership.lock().map_err(|_|"NetBird state unavailable".to_owned())?;
    if state.connected_by_app {return Ok(false);}
    let exe=netbird_binary()?;
    let report=netbird_cli(&exe,"status")?;
    if netbird_is_connected(&report) {return Ok(false);}
    netbird_cli(&exe,"up")?;
    // The "up" command succeeded. Own the connection immediately, even
    // while it is still negotiating with the NetBird management service.
    state.connected_by_app=true;
    for _ in 0..12 {
        if let Ok(report)=netbird_cli(&exe,"status") {
            if netbird_is_connected(&report){return Ok(true);}
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    Err("NetBird started but is still connecting. Check its desktop client; Minecraft Cloud will keep the VPN managed and disconnect it on exit.".into())
}

fn disconnect_owned_netbird(ownership: &Mutex<NetbirdOwnership>) {
    let Ok(mut state)=ownership.lock() else {return;};
    let was_owned=state.connected_by_app;
    if !was_owned {return;}
    state.connected_by_app=false;
    if let Ok(exe)=netbird_binary() {
        let _=netbird_cli(&exe,"down");
    }
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct NetbirdAutoStatus { enabled: bool, connected: bool, owned_by_app: bool }

#[tauri::command]
fn netbird_auto_status(ownership: tauri::State<'_,Mutex<NetbirdOwnership>>) -> NetbirdAutoStatus {
    let connected=netbird_binary().and_then(|exe|netbird_cli(&exe,"status"))
        .map(|s|netbird_is_connected(&s)).unwrap_or(false);
    NetbirdAutoStatus {
        enabled:auto_netbird_enabled(),connected,
        owned_by_app:ownership.lock().map(|s|s.connected_by_app).unwrap_or(false),
    }
}
#[tauri::command]
fn netbird_set_auto(
    enabled: bool, ownership: tauri::State<'_,Mutex<NetbirdOwnership>>
) -> Result<NetbirdAutoStatus,String> {
    save_secret(AUTO_NETBIRD,if enabled {"on"} else {"off"})?;
    // The user is explicitly opting in or out: apply the change now too.
    let state=ownership.inner();
    if enabled {
        connect_netbird_if_needed(state)?;
    } else {
        disconnect_owned_netbird(state);
    }
    Ok(netbird_auto_status(ownership))
}

// NetBird-only direct control (no Cloudflare, no public RCON).
// Automatic discovery reads the local NetBird CLI, not GitHub logs or
// a stale GitHub runner hostname. A private PIN-like shared secret is
// stored only in Windows Credential Manager.
const DIRECT_SECRET: &str = "netbird-direct-token";
const DIRECT_PEER: &str = "netbird-direct-peer";

fn private_overlay_ip(value: &str) -> bool {
    let Ok(ip)=value.parse::<std::net::Ipv4Addr>() else { return false; };
    let parts=ip.octets();
    parts[0]==100 && (64..=127).contains(&parts[1])
}

// NetBird may append the final IPv4 octets to its hostname to keep names unique:
// minecraft-paper-<run_id>-29-165.netbird.cloud. Keep the numeric GitHub
// run ID for ordering, and reject unrelated or malformed hostnames.
fn runner_peer_id(name: &str) -> Option<u64> {
    let hostname = name.split('.').next()?.to_ascii_lowercase();
    let suffix = hostname.strip_prefix("minecraft-paper-")?;
    let mut parts = suffix.split('-');
    let run_id = parts.next()?.parse::<u64>().ok().filter(|run| *run > 0)?;
    let extra = parts.collect::<Vec<_>>();
    if !extra.is_empty() && (extra.len() != 2 || extra.iter().any(|part|
        part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit())
    )) {
        return None;
    }
    Some(run_id)
}
// NetBird officially exposes stable JSON: peers.details[] contains fqdn,
// netbirdIp and status. Prefer this over terminal text parsing.
fn parse_peer_json(report: &str) -> Option<String> {
    let body: Value=serde_json::from_str(report).ok()?;
    let peers=body.get("peers")?.get("details")?.as_array()?;
    let mut candidates=Vec::new();
    for peer in peers {
        let Some(fqdn)=peer.get("fqdn").and_then(Value::as_str) else {continue;};
        let Some(id)=runner_peer_id(fqdn) else {continue;};
        let Some(ip)=peer.get("netbirdIp").and_then(Value::as_str) else {continue;};
        let Some(status)=peer.get("status").and_then(Value::as_str) else {continue;};
        if private_overlay_ip(ip) && matches!(
            status.to_ascii_lowercase().as_str(),"connected"|"connecting"|"idle"
        ) {
            candidates.push((id,ip.to_owned()));
        }
    }
    candidates.sort_unstable_by_key(|x|x.0);
    candidates.pop().map(|x|x.1)
}
fn parse_peer_table(report: &str) -> Option<String> {
    let mut peers=Vec::new();
    for line in report.lines() {
        let cols=line.split_whitespace().collect::<Vec<_>>();
        if cols.len()<3 {continue;}
        let Some(id)=runner_peer_id(cols[0]) else {continue;};
        // NetBird lazy connections are "Idle" until the first packet opens a
        // WireGuard session. Rejecting Idle here prevents that first packet.
        if !private_overlay_ip(cols[1]) {continue;}
        let status=cols[2].to_ascii_lowercase();
        if !matches!(status.as_str(),"connected"|"connecting"|"idle") {continue;}
        peers.push((id,cols[1].to_owned()));
    }
    peers.sort_unstable_by_key(|x|x.0);
    peers.pop().map(|x|x.1)
}
fn parse_peer_details(report: &str) -> Option<String> {
    let mut peers=Vec::new();
    let mut id=None;
    let mut ip=None;
    let mut connected=false;
    let mut finish=|id: Option<u64>,ip: Option<String>,connected: bool| {
        if let (Some(id),Some(ip))=(id,ip){
            if connected && private_overlay_ip(&ip){peers.push((id,ip));}
        }
    };
    for line in report.lines() {
        let trimmed=line.trim();
        // Peer blocks begin with a hostname followed by ':'.
        if let Some(name)=trimmed.strip_suffix(':') {
            if let Some(new_id)=runner_peer_id(name) {
                finish(id,ip.take(),connected);
                id=Some(new_id);ip=None;connected=false;
                continue;
            }
        }
        if id.is_none(){continue;}
        if let Some(value)=trimmed.strip_prefix("NetBird IP:"){
            ip=Some(value.trim().split('/').next().unwrap_or("").to_owned());
        }
        if let Some(value)=trimmed.strip_prefix("Status:"){
            // Idle peers can be awakened by the first authenticated HTTP request.
            connected=matches!(value.trim().to_ascii_lowercase().as_str(),
                "connected"|"connecting"|"idle");
        }
    }
    finish(id,ip,connected);
    peers.sort_unstable_by_key(|x|x.0);
    peers.pop().map(|x|x.1)
}
fn find_netbird_peer() -> Result<String, String> {
    let binary=netbird_binary()?;
    // Stable JSON is supported by older and newer NetBird clients.
    if let Ok(report)=netbird_cli_args(&binary,&["status","--json"]){
        if let Some(ip)=parse_peer_json(&report){return Ok(ip);}
    }
    // Retain text fallbacks for NetBird versions with different JSON output.
    if let Ok(table)=netbird_cli_args(&binary,&["status","--table"]){
        if let Some(ip)=parse_peer_table(&table){return Ok(ip);}
    }
    if let Ok(detail)=netbird_cli_args(&binary,&["status","--detail"]){
        if let Some(ip)=parse_peer_details(&detail){return Ok(ip);}
    }
    Err("No connected minecraft-paper runner is visible in NetBird. Check the Windows NetBird app's Peers list and that the GitHub runner belongs to an access group your PC can reach.".into())
}

// Select only the live Paper workflow's NetBird peer. Old transient runner
// names remain in NetBird after their GitHub runner exits; choosing the newest
// historical name can yield misleading TCP timeouts.
static ACTIVE_PAPER_RUN: OnceLock<tokio::sync::Mutex<Option<(std::time::Instant, Option<u64>)>>> = OnceLock::new();

async fn active_paper_run() -> Result<Option<u64>, String> {
    let lock=ACTIVE_PAPER_RUN.get_or_init(||tokio::sync::Mutex::new(None));
    let mut cached=lock.lock().await;
    if let Some((last, id))=*cached {
        if last.elapsed()<std::time::Duration::from_secs(30) {return Ok(id);}
    }
    let response=github("/actions/workflows/paper-state-test.yml/runs?status=in_progress&per_page=20",
        reqwest::Method::GET,None).await?;
    let runs=response["workflow_runs"].as_array()
        .ok_or("GitHub did not list running Paper workflows")?;
    let run=runs.iter().filter(|r|
        r["status"].as_str()==Some("in_progress") &&
        r["head_branch"].as_str()==Some("main")
    ).filter_map(|r|r["id"].as_u64()).max();
    *cached=Some((std::time::Instant::now(),run));
    Ok(run)
}

fn find_active_netbird_peer(run_id:u64) -> Result<String,String> {
    let binary=netbird_binary()?;
    let report=netbird_cli_args(&binary,&["status","--json"])
        .map_err(|_|"Cannot inspect NetBird peers. Open NetBird and verify it's connected.".to_owned())?;
    let value:Value=serde_json::from_str(&report)
        .map_err(|_|"NetBird peer metadata is invalid; please update NetBird.".to_owned())?;
    let peers=value.pointer("/peers/details").and_then(Value::as_array)
        .ok_or("NetBird did not return a peer list")?;
    let mut stale=0_usize;
    for peer in peers {
        let Some(name)=peer["fqdn"].as_str() else {continue;};
        let Some(id)=runner_peer_id(name) else {continue;};
        let status=peer["status"].as_str().unwrap_or("").to_ascii_lowercase();
        if id!=run_id {
            stale+=1;
            continue;
        }
        if status=="disconnected" {
            return Err(format!("Current Paper runner #{run_id} is disconnected in NetBird. Check runner registration and NetBird network policies."));
        }
        let ip=peer["netbirdIp"].as_str().unwrap_or("");
        if private_overlay_ip(ip) && ["connected","connecting","idle"].contains(&status.as_str()) {
            return Ok(ip.to_owned());
        }
    }
    Err(format!("The active Paper runner #{run_id} is not reachable as a NetBird peer. NetBird lists {stale} older Minecraft runner(s). Check the current GitHub runner's 'Connect private NetBird management network' step and NetBird access policies."))
}

// An authenticated status probe, not a NetBird "Connected" label, is the
// source of truth. A connected overlay peer can be an old/reused GitHub runner.
static VERIFIED_PEER: OnceLock<tokio::sync::Mutex<Option<(std::time::Instant,String)>>> = OnceLock::new();
async fn selected_direct_peer_ip() -> Result<String,String> {
    let manual=secret(DIRECT_PEER).unwrap_or_default();
    if !manual.is_empty() {
        if !private_overlay_ip(&manual) {return Err("Configured NetBird IP is invalid".into());}
        return Ok(manual);
    }
    let cache=VERIFIED_PEER.get_or_init(||tokio::sync::Mutex::new(None));
    {
        let guard=cache.lock().await;
        if let Some((when,ip))=&*guard {
            if when.elapsed()<std::time::Duration::from_secs(15) {return Ok(ip.clone());}
        }
    }
    let token=secret(DIRECT_SECRET).map_err(|_|"Set the direct-control secret in Connections first".to_owned())?;
    if token.len()<8 {return Err("Direct-control token must be at least 8 characters".into());}
    let binary=netbird_binary()?;
    let report=tokio::task::spawn_blocking(move ||
        netbird_cli_args(&binary,&["status","--json"])
    ).await.map_err(|_|"Cannot inspect NetBird peers".to_owned())??;
    let value:Value=serde_json::from_str(&report)
        .map_err(|_|"NetBird returned invalid peer metadata".to_owned())?;
    let peers=value.pointer("/peers/details").and_then(Value::as_array)
        .ok_or("NetBird did not return a peer list")?;
    let mut candidates=Vec::new();
    for peer in peers {
        let Some(id)=peer["fqdn"].as_str().and_then(runner_peer_id) else {continue;};
        let ip=peer["netbirdIp"].as_str().unwrap_or("");
        let status=peer["status"].as_str().unwrap_or("").to_ascii_lowercase();
        if private_overlay_ip(ip)&&["connected","connecting","idle"].contains(&status.as_str()){
            candidates.push((id,ip.to_owned(),status));
        }
    }
    if candidates.is_empty(){
        return Err("No reachable Minecraft Paper peers in NetBird. Start the server or check NetBird policies.".into());
    }
    // Prefer recently connected peers but test all plausible runners rather
    // than assuming the largest GitHub run ID is the only live one.
    let active=if secret(GITHUB_SECRET).is_ok(){active_paper_run().await.ok().flatten()}else{None};
    candidates.sort_by_key(|(id,_,status)|(
        active==Some(*id),status=="connected",*id
    ));
    let client=reqwest::Client::builder().no_proxy()
        .timeout(std::time::Duration::from_millis(1300))
        .build().map_err(|_|"Couldn't initialize NetBird probe".to_owned())?;
    let count=candidates.len();
    for (_,ip,_) in candidates.into_iter().rev().take(16) {
        let url=format!("http://{ip}:8765/api/status");
        if let Ok(response)=client.get(&url).bearer_auth(&token).send().await {
            if response.status().is_success() {
                if let Ok(body)=response.json::<Value>().await {
                    if body["session"].as_str().is_some_and(|s|!s.is_empty()) {
                        *cache.lock().await=Some((std::time::Instant::now(),ip.clone()));
                        return Ok(ip);
                    }
                }
            }
        }
    }
    Err(format!("Found {count} NetBird Minecraft peer(s), but none answered authenticated TCP/8765. Check the running Paper control service and NetBird access policy."))
}

fn direct_peer_ip() -> Result<String, String> {
    let manual=secret(DIRECT_PEER).unwrap_or_default();
    if !manual.is_empty() {
        if !private_overlay_ip(&manual) {
            return Err("Configured peer IP is not a private NetBird address".into());
        }
        return Ok(manual);
    }
    find_netbird_peer()
}

fn direct_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
      .no_proxy()
      .timeout(std::time::Duration::from_secs(12))
      .build().map_err(|_|"Couldn't create private connection".to_owned())
}
async fn direct_request(kind: &str, command: Option<Value>) -> Result<Value, String> {
    let token=secret(DIRECT_SECRET).map_err(|_|"Direct Paper needs a separate secret. Set MINECRAFT_DIRECT_TOKEN in GitHub Actions Secrets, then enter the exact same value under Connections → Direct Paper.".to_owned())?;
    if token.len()<8 {return Err("Direct control token must be at least 8 characters".into());}
    // CLI peer discovery is a blocking OS process. Keep it off Tauri's
    // async executor so frequent status checks cannot freeze other commands.
    let ip=selected_direct_peer_ip().await?;
    let url=format!("http://{ip}:8765/api/{kind}");
    let mut client_builder=reqwest::Client::builder().no_proxy();
    let is_install=command.as_ref().and_then(|body|body.get("type")).and_then(Value::as_str)==Some("marketplace-install");
    client_builder=client_builder.timeout(std::time::Duration::from_secs(if is_install { 150 } else { 12 }));
    let client=client_builder.build().map_err(|_|"Couldn't create private connection".to_owned())?;
    let req=match command {
        Some(body)=>client.post(url).json(&body),
        None=>client.get(url)
    };
    let response=req.bearer_auth(token).send().await.map_err(|e|{
        if e.is_timeout() {
            return format!("NetBird peer {ip} found, but Paper control port 8765 timed out. Check NetBird access policies for TCP/8765 and the runner log for 'Direct NetBird Paper control listening'.");
        }
        if e.is_connect(){
            return format!("NetBird peer {ip} found, but Paper control port 8765 is unreachable. Check the runner log for 'Direct NetBird Paper control listening' and allow TCP/8765 from this PC in NetBird.");
        }
        "NetBird peer found, but the private Paper request failed. Verify Windows NetBird is connected.".to_owned()
    })?;
    let code=response.status();
    let body=response.json::<Value>().await.map_err(|_|"Invalid private Paper response".to_owned())?;
    if !code.is_success(){
        if code.as_u16()==401 {
            return Err("NetBird reached the Paper server, but the direct-control token was rejected (HTTP 401). Enter the exact MINECRAFT_DIRECT_TOKEN value used by the currently running GitHub job.".into());
        }
        return Err(format!("Direct Paper HTTP {}: {}",code.as_u16(),
            body["error"].as_str().unwrap_or("Unknown server error").chars().take(160).collect::<String>()));
    }
    Ok(body)
}
#[tauri::command]
fn direct_peer_config() -> Value {
    let saved=secret(DIRECT_PEER).unwrap_or_default();
    json!({"manual":!saved.is_empty(),"peerIp":saved})
}
#[tauri::command]
fn direct_clear_peer() -> Result<Value, String> {
    // Revert to active-run discovery without requiring the user to re-enter
    // their separately stored direct-control token.
    remove_secret(DIRECT_PEER)?;
    Ok(json!({"manual":false,"peerIp":""}))
}
#[tauri::command]
fn direct_configure(token: String, peer_ip: String) -> Result<(), String> {
    let trimmed=token.trim();
    if trimmed.len()<8 || trimmed.len()>512 {
        return Err("Enter a direct-control token (at least 8 characters)".into());
    }
    let peer=peer_ip.trim();
    if !peer.is_empty() && !private_overlay_ip(peer) {
        return Err("Manual server IP must be a NetBird address in 100.64.0.0/10".into());
    }
    save_secret(DIRECT_SECRET,trimmed)?;
    if peer.is_empty(){let _=remove_secret(DIRECT_PEER);}
    else {save_secret(DIRECT_PEER,peer)?;}
    Ok(())
}
// A single native event stream keeps the WebView free of CORS, credentials,
// and the overhead of invoking direct_status several times per second.
static STREAM_STARTED: OnceLock<()> = OnceLock::new();
#[tauri::command]
async fn direct_start_stream(app: tauri::AppHandle) -> Result<(), String> {
    if STREAM_STARTED.set(()).is_err() { return Ok(()); }
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder().no_proxy()
            .connect_timeout(std::time::Duration::from_secs(5))
            .build() {
            Ok(client) => client,
            Err(_) => return,
        };
        loop {
            // Token and peer selection can change in Connections. Rediscover
            // on reconnect without ever sending credentials to the frontend.
            let token = secret(DIRECT_SECRET);
            let peer = selected_direct_peer_ip().await;
            if let (Ok(token), Ok(ip)) = (token, peer) {
                if token.len() >= 8 {
                    let endpoint = format!("http://{ip}:8765/api/events");
                    if let Ok(response) = client.get(&endpoint).bearer_auth(token).send().await {
                        if response.status().is_success() {
                            let mut stream = response.bytes_stream();
                            let mut buffer = String::new();
                            // Server emits a sample every second. If a
                            // broken connection silently stalls, reconnect
                            // instead of leaving the UI falsely marked live.
                            while let Ok(Some(chunk)) = tokio::time::timeout(
                                std::time::Duration::from_secs(8), stream.next()
                            ).await {
                                match chunk {
                                    Ok(bytes) => {
                                        buffer.push_str(&String::from_utf8_lossy(&bytes));
                                        // Bound the untrusted stream, and never emit malformed JSON.
                                        if buffer.len() > 1_048_576 { break; }
                                        while let Some(end) = buffer.find("\n\n") {
                                            let frame: String = buffer.drain(..end+2).collect();
                                            if let Some(data) = frame.strip_prefix("data: ") {
                                                if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
                                                    let _ = app.emit("paper-live-status", value);
                                                }
                                            }
                                        }
                                    }
                                    Err(_) => break,
                                }
                            }
                        }
                    }
                }
            }
            let _ = app.emit("paper-live-disconnected", json!({}));
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    });
    Ok(())
}
#[tauri::command]
async fn modrinth_search(
    query: String, kind: String, category: String, sort: String,
    version: String, loader: String, offset: u32,
) -> Result<Value, String> {
    // Only allow known facets. Facet expressions must never be built from
    // arbitrary input accepted from the WebView.
    const CATEGORIES: &[&str] = &[
        "adventure","cursed","decoration","economy","equipment","food",
        "game-mechanics","library","magic","management","minigame","mobs",
        "optimization","social","storage","technology","transportation",
        "utility","worldgen"
    ];
    const VERSIONS: &[&str] = &[
        "26.3","26.2","26.1.2","26.1.1","26.1","1.21.11","1.21.10"
    ];
    const SORTS: &[&str] = &["relevance","downloads","follows","updated","newest"];
    const LOADERS: &[&str] = &["paper","purpur","spigot","bukkit"];
    if !["plugin","datapack"].contains(&kind.as_str())
        || query.len()>100
        || !CATEGORIES.contains(&category.as_str()) && !category.is_empty()
        || !VERSIONS.contains(&version.as_str()) && !version.is_empty()
        || !SORTS.contains(&sort.as_str())
        || !LOADERS.contains(&loader.as_str()) && !loader.is_empty()
        || (kind=="datapack" && !loader.is_empty())
        || offset>5000 {
        return Err("Invalid Modrinth marketplace filters".into());
    }
    let mut facets=vec![vec![format!("all_project_types:{kind}")]];
    if !version.is_empty() { facets.push(vec![format!("versions:{version}")]); }
    if !category.is_empty() { facets.push(vec![format!("categories:{category}")]); }
    if !loader.is_empty() { facets.push(vec![format!("categories:{loader}")]); }
    let facets=serde_json::to_string(&facets).map_err(|_|"Invalid Modrinth facets".to_owned())?;
    let query_params=[
        ("query",query.as_str()),("facets",facets.as_str()),
        ("index",sort.as_str()),("limit","20"),("offset","")
    ];
    // Provide pagination as a validated decimal field, not an unchecked URL.
    let offset_str=offset.to_string();
    let query_params=[
        query_params[0],query_params[1],query_params[2],query_params[3],
        ("offset",offset_str.as_str())
    ];
    let response=http().get("https://api.modrinth.com/v2/search")
        .query(&query_params)
        .send().await.map_err(|_|"Modrinth search is unavailable".to_owned())?;
    if !response.status().is_success() {
        return Err(format!("Modrinth search HTTP {}",response.status().as_u16()));
    }
    response.json().await.map_err(|_|"Invalid Modrinth search results".into())
}
#[tauri::command]
async fn modrinth_versions(project_id: String, kind: String) -> Result<Value, String> {
    if project_id.len()<3 || project_id.len()>32 ||
       !project_id.chars().all(|c| c.is_ascii_alphanumeric()) ||
       !["plugin","datapack"].contains(&kind.as_str()) {
        return Err("Invalid Modrinth project".into());
    }
    let url=format!("https://api.modrinth.com/v2/project/{project_id}/version");
    let response=http().get(url)
        .query(&[("game_versions",r#"["26.3"]"#),("include_changelog","false")])
        .send().await.map_err(|_|"Modrinth versions are unavailable".to_owned())?;
    if !response.status().is_success() {
        return Err(format!("Modrinth versions HTTP {}",response.status().as_u16()));
    }
    let versions=response.json::<Value>().await.map_err(|_|"Invalid Modrinth versions".to_owned())?;
    let compatible=versions.as_array().ok_or("Invalid versions response")?
        .iter().filter(|v| {
            let loaders=v["loaders"].as_array();
            let supported=loaders.map(|items| items.iter().any(|l| {
                let l=l.as_str().unwrap_or("");
                if kind=="plugin" { ["paper","spigot","bukkit","purpur"].contains(&l) }
                else { l=="datapack" }
            })).unwrap_or(false);
            supported && v["game_versions"].as_array().map(|games|
                games.iter().any(|g|g.as_str()==Some("26.3"))).unwrap_or(false)
        }).cloned().collect::<Vec<_>>();
    Ok(Value::Array(compatible))
}
#[tauri::command]
async fn direct_status() -> Result<Value, String> { direct_request("status",None).await }
#[tauri::command]
async fn direct_command(kind: String, args: Value) -> Result<Value, String> {
    const ALLOWED: &[&str]=&[
        "console","save","restart","shutdown","kick","ban","pardon",
        "whitelist-add","whitelist-remove","whitelist-on","whitelist-off",
        "op","deop","plugins-list","files-list","files-tree","files-read",
        "files-write","files-delete","files-mkdir","files-rename",
        "files-upload","files-download","marketplace-install",
    ];
    if !ALLOWED.contains(&kind.as_str()) { return Err("Unsupported Paper command".into());}
    if !args.is_object(){return Err("Invalid command arguments".into());}
    direct_request("command",Some(json!({"type":kind,"args":args}))).await
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(NetbirdOwnership::default()))
        .setup(|app| {
            if auto_netbird_enabled() {
                let handle=app.handle().clone();
                std::thread::spawn(move || {
                    if let Some(state)=handle.try_state::<Mutex<NetbirdOwnership>>() {
                        // Best-effort; a VPN failure never stops the desktop app.
                        let _=connect_netbird_if_needed(state.inner());
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connect_github,disconnect_github,github_status,github_overview,
            github_workflows,github_runs,github_dispatch,github_cancel,github_jobs,github_job_log,
            github_file,github_save_file,github_download_backup,
            server_files_pending,server_files_stage,server_files_unstage,
            server_files_list,server_files_read,server_settings_get,server_settings_save,
            modrinth_queue_list,modrinth_queue_add,modrinth_queue_remove,
            desktop_check_update,desktop_install_update,
            configure_cloudflare,cloudflare_status,cloudflare_command,cloudflare_console,
            server_restore_backup,
            direct_configure,direct_peer_config,direct_clear_peer,direct_status,direct_start_stream,direct_command,
            modrinth_search,modrinth_versions,
            netbird_auto_status,netbird_set_auto
        ])
        .build(tauri::generate_context!())
        .expect("error building Minecraft Cloud Desktop")
        .run(|app,event| {
            if let tauri::RunEvent::Exit=event {
                if let Some(state)=app.try_state::<Mutex<NetbirdOwnership>>() {
                    disconnect_owned_netbird(state.inner());
                }
            }
        });
}
