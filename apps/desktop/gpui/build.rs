fn main() {
    println!("cargo:rerun-if-changed=../native-assets/icons/icon.png");
    println!("cargo:rerun-if-changed=explorie.manifest");
    println!("cargo:rerun-if-env-changed=CARGO_PKG_VERSION");

    generate_titlebar_icon();

    #[cfg(windows)]
    embed_windows_resources();
}

fn generate_titlebar_icon() {
    use std::env;
    use std::path::PathBuf;

    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let output_dir = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let source = manifest_dir.join("../native-assets/icons/icon.png");
    let output = output_dir.join("titlebar-icon.png");
    let source_image = image::open(&source)
        .unwrap_or_else(|error| panic!("failed to decode {}: {error}", source.display()))
        .into_rgba8();

    let mut left = source_image.width();
    let mut top = source_image.height();
    let mut right = 0;
    let mut bottom = 0;
    for (x, y, pixel) in source_image.enumerate_pixels() {
        if pixel[3] > 8 {
            left = left.min(x);
            top = top.min(y);
            right = right.max(x);
            bottom = bottom.max(y);
        }
    }
    assert!(
        left <= right && top <= bottom,
        "{} must contain visible pixels",
        source.display()
    );

    let cropped =
        image::imageops::crop_imm(&source_image, left, top, right - left + 1, bottom - top + 1)
            .to_image();
    let resized = image::DynamicImage::ImageRgba8(cropped)
        .resize(44, 36, image::imageops::FilterType::Lanczos3)
        .into_rgba8();
    let mut canvas = image::RgbaImage::new(44, 36);
    image::imageops::overlay(
        &mut canvas,
        &resized,
        i64::from((44 - resized.width()) / 2),
        i64::from((36 - resized.height()) / 2),
    );
    canvas
        .save_with_format(&output, image::ImageFormat::Png)
        .unwrap_or_else(|error| panic!("failed to write {}: {error}", output.display()));
}

#[cfg(windows)]
fn embed_windows_resources() {
    use std::env;
    use std::fs::{self, File};
    use std::path::{Path, PathBuf};

    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let output_dir = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let source = manifest_dir.join("../native-assets/icons/icon.png");
    let icon_path = output_dir.join("explorie.ico");
    let resource_path = output_dir.join("explorie.rc");
    let manifest_path = manifest_dir.join("explorie.manifest");
    let package_version = env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION is set by Cargo");
    let mut version_parts = package_version
        .split(['.', '-'])
        .take(3)
        .map(|part| part.parse::<u16>().unwrap_or(0));
    let version_numbers = format!(
        "{},{},{},0",
        version_parts.next().unwrap_or(0),
        version_parts.next().unwrap_or(0),
        version_parts.next().unwrap_or(0)
    );

    let source_image = image::open(&source)
        .unwrap_or_else(|error| panic!("failed to decode {}: {error}", source.display()))
        .into_rgba8();
    assert_eq!(
        source_image.width(),
        source_image.height(),
        "{} must be square",
        source.display()
    );
    assert!(
        source_image.width() >= 256,
        "{} must be at least 256x256",
        source.display()
    );

    let mut icon = ico::IconDir::new(ico::ResourceType::Icon);
    for size in [16, 20, 24, 32, 40, 48, 64, 128, 256] {
        let resized = image::imageops::resize(
            &source_image,
            size,
            size,
            image::imageops::FilterType::Lanczos3,
        );
        let image = ico::IconImage::from_rgba_data(size, size, resized.into_raw());
        icon.add_entry(
            ico::IconDirEntry::encode(&image)
                .unwrap_or_else(|error| panic!("failed to encode {size}px app icon: {error}")),
        );
    }
    icon.write(
        File::create(&icon_path)
            .unwrap_or_else(|error| panic!("failed to create {}: {error}", icon_path.display())),
    )
    .unwrap_or_else(|error| panic!("failed to write {}: {error}", icon_path.display()));

    let resource = format!(
        concat!(
            "#define RT_MANIFEST 24\n",
            "1 RT_MANIFEST \"{}\"\n",
            "1 ICON \"{}\"\n",
            "1 VERSIONINFO\n",
            "FILEVERSION {}\n",
            "PRODUCTVERSION {}\n",
            "FILEFLAGSMASK 0x3fL\n",
            "FILEOS 0x40004L\n",
            "FILETYPE 0x1L\n",
            "BEGIN\n",
            "  BLOCK \"StringFileInfo\"\n",
            "  BEGIN\n",
            "    BLOCK \"040904b0\"\n",
            "    BEGIN\n",
            "      VALUE \"CompanyName\", \"Explorie contributors\\0\"\n",
            "      VALUE \"FileDescription\", \"Explorie file manager\\0\"\n",
            "      VALUE \"FileVersion\", \"{}\\0\"\n",
            "      VALUE \"InternalName\", \"Explorie\\0\"\n",
            "      VALUE \"OriginalFilename\", \"Explorie.exe\\0\"\n",
            "      VALUE \"ProductName\", \"Explorie\\0\"\n",
            "      VALUE \"ProductVersion\", \"{}\\0\"\n",
            "    END\n",
            "  END\n",
            "  BLOCK \"VarFileInfo\"\n",
            "  BEGIN\n",
            "    VALUE \"Translation\", 0x409, 1200\n",
            "  END\n",
            "END\n"
        ),
        rc_path(&manifest_path),
        rc_path(&icon_path),
        version_numbers,
        version_numbers,
        package_version,
        package_version
    );
    fs::write(&resource_path, resource).unwrap_or_else(|error| {
        panic!(
            "failed to write generated resource {}: {error}",
            resource_path.display()
        )
    });
    embed_resource::compile(&resource_path, embed_resource::NONE)
        .manifest_required()
        .expect("failed to embed the generated Windows icon and application manifest");

    fn rc_path(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }
}
