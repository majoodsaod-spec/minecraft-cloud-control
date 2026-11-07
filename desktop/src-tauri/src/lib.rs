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
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            connect_github,disconnect_github,github_status,github_overview,
            github_workflows,github_runs,github_dispatch,github_cancel,github_jobs,github_job_log,
            github_file,github_save_file,github_download_backup,
            configure_cloudflare,cloudflare_status,cloudflare_command,cloudflare_console
        ])
        .run(tauri::generate_context!())
        .expect("error launching Minecraft Cloud Desktop");
}
