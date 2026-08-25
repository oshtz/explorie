fn main() {
    #[cfg(windows)]
    embed_resource::compile("explorie.rc", embed_resource::NONE)
        .manifest_required()
        .expect("failed to embed the Windows application manifest");
}
