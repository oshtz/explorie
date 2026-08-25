fn main() {
    #[cfg(target_os = "macos")]
    {
        let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("../../apps/desktop/native-assets/macos");
        println!(
            "cargo:rerun-if-changed={}",
            root.join("MountHelper.h").display()
        );
        println!(
            "cargo:rerun-if-changed={}",
            root.join("MountBridge.m").display()
        );
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=framework=ServiceManagement");
        cc::Build::new()
            .file(root.join("MountBridge.m"))
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .flag("-mmacosx-version-min=13.0")
            .compile("explorie_mount_bridge");
    }
}
