fn main() {
    println!("cargo:rerun-if-env-changed=MC_DESKTOP_BUILD_RUN_ID");
    let build = std::env::var("MC_DESKTOP_BUILD_RUN_ID").unwrap_or_else(|_| "0".to_owned());
    println!("cargo:rustc-env=MC_DESKTOP_BUILD_RUN_ID={build}");
    tauri_build::build();
}
