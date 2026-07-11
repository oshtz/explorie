fn main() {
    #[cfg(target_os = "macos")]
    build_macos_mount_helper();
    tauri_build::build();
}

#[cfg(target_os = "macos")]
fn build_macos_mount_helper() {
    use std::path::PathBuf;
    use std::process::Command;

    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("macos");
    let output = root.join("build");
    std::fs::create_dir_all(&output).unwrap();
    let team_id = std::env::var("APPLE_TEAM_ID").unwrap_or_default();

    println!("cargo:rerun-if-changed=macos/MountHelper.h");
    println!("cargo:rerun-if-changed=macos/MountBridge.m");
    println!("cargo:rerun-if-changed=macos/MountDaemon.m");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=Security");
    println!("cargo:rustc-link-lib=framework=ServiceManagement");

    cc::Build::new()
        .file(root.join("MountBridge.m"))
        .flag("-fobjc-arc")
        .flag("-fblocks")
        .flag("-mmacosx-version-min=13.0")
        .compile("explorie_mount_bridge");

    let status = Command::new("xcrun")
        .args([
            "clang",
            "-fobjc-arc",
            "-fblocks",
            "-mmacosx-version-min=13.0",
            "-framework",
            "Foundation",
            "-framework",
            "Security",
        ])
        .arg(format!("-DEXPLORIE_TEAM_ID=\"{team_id}\""))
        .arg(root.join("MountDaemon.m"))
        .args(["-o"])
        .arg(output.join("explorie-mountd"))
        .status()
        .expect("failed to run xcrun clang for the macOS mount helper");
    assert!(status.success(), "failed to build the macOS mount helper");

    let identity = std::env::var("APPLE_SIGNING_IDENTITY").unwrap_or_else(|_| "-".to_string());
    let mut codesign = Command::new("codesign");
    codesign.args([
        "--force",
        "--options",
        "runtime",
        "--identifier",
        "com.omershatz.explorie.mountd",
        "--sign",
        &identity,
    ]);
    if identity != "-" {
        codesign.arg("--timestamp");
    }
    let status = codesign
        .arg(output.join("explorie-mountd"))
        .status()
        .expect("failed to run codesign for the macOS mount helper");
    assert!(status.success(), "failed to sign the macOS mount helper");
}
