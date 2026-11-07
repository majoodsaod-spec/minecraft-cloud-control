use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;


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
    use futures_util::StreamExt;
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
}

async fn current_update() -> Result<UpdateCheck, String> {
    // GitHub returns newest first. Never offer unfinished, failing, or
    // arbitrary-branch artifacts as application updates.
    let path=format!("/actions/workflows/{INSTALLER_WORKFLOW}/runs?branch=main&status=success&per_page=12");
    let runs=github(&path, reqwest::Method::GET, None).await?;
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
                artifact_id,
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
    use futures_util::StreamExt;
    let mut stream=response.bytes_stream();
    let mut total=0_u64;
    while let Some(next)=stream.next().await {
        let chunk=next.map_err(|_|"The update download was interrupted")?;
        total+=chunk.len() as u64;
        if total>DOWNLOAD_LIMIT {
            let _=tokio::fs::remove_file(&zip_file).await;
            return Err("Update exceeds the download safety limit".into());
        }
        output.write_all(&chunk).await.map_err(|_|"Couldn't save the update")?;
    }
    output.flush().await.map_err(|_|"Couldn't finish the update download")?;
    drop(output);

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
    use futures_util::StreamExt;
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

fn find_netbird_peer() -> Result<String, String> {
    let mut binaries=vec![std::path::PathBuf::from("netbird")];
    for name in [
        r"C:\Program Files\NetBird\netbird.exe",
        r"C:\Program Files\NetBird\bin\netbird.exe",
        r"C:\Program Files (x86)\NetBird\netbird.exe"
    ] {
        binaries.push(name.into());
    }
    let mut output=None;
    for binary in binaries {
        if let Ok(result)=std::process::Command::new(&binary)
            .args(["status","--table","--filter-by-names","minecraft-paper"])
            .output() {
            if result.status.success() {
                output=Some(String::from_utf8_lossy(&result.stdout).into_owned());
                break;
            }
        }
    }
    let report=output.ok_or("NetBird CLI unavailable. Ensure NetBird is installed and connected.")?;
    let mut candidates=Vec::new();
    for line in report.lines() {
        let columns=line.split_whitespace().collect::<Vec<_>>();
        if columns.len()<3 {continue;}
        let peer=columns[0].to_ascii_lowercase();
        if !peer.starts_with("minecraft-paper-") {continue;}
        let ip=columns[1];
        if !private_overlay_ip(ip) {continue;}
        if !columns[2].eq_ignore_ascii_case("connected") {continue;}
        let id=peer.trim_start_matches("minecraft-paper-")
            .parse::<u64>().unwrap_or(0);
        if id==0 {continue;}
        candidates.push((id,ip.to_owned()));
    }
    candidates.sort_unstable_by_key(|x|x.0);
    candidates.pop().map(|x|x.1).ok_or(
        "No connected minecraft-paper runner found in NetBird. Check that the new GitHub Actions session joined the same NetBird network.".to_owned()
    )
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
      .timeout(std::time::Duration::from_secs(6))
      .build().map_err(|_|"Couldn't create private connection".to_owned())
}
async fn direct_request(kind: &str, command: Option<Value>) -> Result<Value, String> {
    let token=secret(DIRECT_SECRET)?;
    if token.len()<24 {return Err("Direct control token must be at least 24 characters".into());}
    let ip=direct_peer_ip()?;
    let url=format!("http://{ip}:8765/api/{kind}");
    let client=direct_client()?;
    let req=match command {
        Some(body)=>client.post(url).json(&body),
        None=>client.get(url)
    };
    let response=req.bearer_auth(token).send().await.map_err(|_|{
        "Can't reach Paper over NetBird. Check that both peers are connected and the runner has MINECRAFT_DIRECT_TOKEN.".to_owned()
    })?;
    let code=response.status();
    let body=response.json::<Value>().await.map_err(|_|"Invalid private Paper response".to_owned())?;
    if !code.is_success(){
        return Err(format!("Direct Paper HTTP {}: {}",code.as_u16(),
            body["error"].as_str().unwrap_or("Unknown server error").chars().take(160).collect::<String>()));
    }
    Ok(body)
}
#[tauri::command]
fn direct_configure(token: String, peer_ip: String) -> Result<(), String> {
    let trimmed=token.trim();
    if trimmed.len()<24 || trimmed.len()>512 {
        return Err("Enter a strong direct-control token (at least 24 characters)".into());
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
#[tauri::command]
async fn direct_status() -> Result<Value, String> { direct_request("status",None).await }
#[tauri::command]
async fn direct_command(kind: String, args: Value) -> Result<Value, String> {
    const ALLOWED: &[&str]=&[
        "console","save","restart","shutdown","kick","ban","pardon",
        "whitelist-add","whitelist-remove","whitelist-on","whitelist-off",
        "op","deop","plugins-list","files-list","files-tree","files-read",
        "files-write","files-delete","files-mkdir","files-rename",
        "files-upload","files-download",
    ];
    if !ALLOWED.contains(&kind.as_str()) { return Err("Unsupported Paper command".into());}
    if !args.is_object(){return Err("Invalid command arguments".into());}
    direct_request("command",Some(json!({"type":kind,"args":args}))).await
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            connect_github,disconnect_github,github_status,github_overview,
            github_workflows,github_runs,github_dispatch,github_cancel,github_jobs,github_job_log,
            github_file,github_save_file,github_download_backup,
            desktop_check_update,desktop_install_update,
            configure_cloudflare,cloudflare_status,cloudflare_command,cloudflare_console,
            direct_configure,direct_status,direct_command
        ])
        .run(tauri::generate_context!())
        .expect("error launching Minecraft Cloud Desktop");
}
