use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemIntegrationStatus {
    pub supported: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCommandSpec {
    pub adapter: &'static str,
    pub program: String,
    pub args: Vec<String>,
    pub available: bool,
    pub presents_ui: bool,
}

const WINDOWS_SYSTEM_INTEGRATION: &str = "windows_system_integration";
const MACOS_FINDER_TAGS: &str = "macos_finder_tags";
const MACOS_QUICK_LOOK: &str = "macos_quick_look";
const OPEN_WITH: &str = "open_with";

pub fn fail(adapter: &'static str, detail: impl std::fmt::Display) -> String {
    format!("{adapter}: {detail}")
}

pub fn finder_tag_colors() -> HashMap<String, u8> {
    HashMap::from([
        ("None".to_string(), 0),
        ("Gray".to_string(), 1),
        ("Green".to_string(), 2),
        ("Purple".to_string(), 3),
        ("Blue".to_string(), 4),
        ("Yellow".to_string(), 5),
        ("Red".to_string(), 6),
        ("Orange".to_string(), 7),
    ])
}

pub fn system_integration_status() -> Result<SystemIntegrationStatus, String> {
    #[cfg(target_os = "windows")]
    {
        windows_system_integration::enabled()
            .map(|enabled| SystemIntegrationStatus {
                supported: true,
                enabled,
            })
            .map_err(|error| fail(WINDOWS_SYSTEM_INTEGRATION, error))
    }

    #[cfg(not(target_os = "windows"))]
    Ok(SystemIntegrationStatus {
        supported: false,
        enabled: false,
    })
}

pub fn set_system_integration(enabled: bool) -> Result<SystemIntegrationStatus, String> {
    #[cfg(target_os = "windows")]
    {
        windows_system_integration::set_enabled(enabled)
            .map_err(|error| fail(WINDOWS_SYSTEM_INTEGRATION, error))?;
        system_integration_status()
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Err(fail(
            WINDOWS_SYSTEM_INTEGRATION,
            "System integration is currently available only on Windows.",
        ))
    }
}

pub fn get_finder_tags(path: &str) -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        macos_finder_tags::get(path)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Ok(Vec::new())
    }
}

pub fn set_finder_tags(path: &str, tags: &[String]) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos_finder_tags::set(path, tags)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, tags);
        Err(fail(
            MACOS_FINDER_TAGS,
            "Finder tags are only available on macOS.",
        ))
    }
}

#[cfg(test)]
const WINDOWS_ALTERNATE_STREAMS: &str = "windows_alternate_streams";
#[cfg(test)]
const MACOS_FINDER_TAG_COLORS: &str = "macos_finder_tag_colors";
#[cfg(test)]
const MACOS_HELPER_STATUS: &str = "macos_helper_status";

pub fn quick_look_spec(path: &str) -> NativeCommandSpec {
    NativeCommandSpec {
        adapter: MACOS_QUICK_LOOK,
        program: "qlmanage".to_string(),
        args: vec!["-p".to_string(), path.to_string()],
        available: cfg!(target_os = "macos") && program_available("qlmanage"),
        presents_ui: true,
    }
}

pub fn open_with_spec(path: &str, app_name: &str) -> NativeCommandSpec {
    #[cfg(target_os = "macos")]
    {
        NativeCommandSpec {
            adapter: OPEN_WITH,
            program: "open".to_string(),
            args: vec!["-a".to_string(), app_name.to_string(), path.to_string()],
            available: program_available("open"),
            presents_ui: true,
        }
    }

    #[cfg(target_os = "windows")]
    {
        let _ = app_name;
        NativeCommandSpec {
            adapter: OPEN_WITH,
            program: "rundll32.exe".to_string(),
            args: vec!["shell32.dll,OpenAs_RunDLL".to_string(), path.to_string()],
            available: program_available("rundll32.exe"),
            presents_ui: true,
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (path, app_name);
        NativeCommandSpec {
            adapter: OPEN_WITH,
            program: String::new(),
            args: Vec::new(),
            available: false,
            presents_ui: true,
        }
    }
}

pub fn launch_quick_look(path: &str) -> Result<(), String> {
    let spec = quick_look_spec(path);
    if !cfg!(target_os = "macos") {
        return Err(fail(
            MACOS_QUICK_LOOK,
            "Quick Look is only available on macOS.",
        ));
    }
    spawn_ui_command(&spec, "Failed to open Quick Look")
}

pub fn launch_open_with(path: &str, app_name: &str) -> Result<(), String> {
    let spec = open_with_spec(path, app_name);
    if !spec.available {
        return Err(fail(
            OPEN_WITH,
            "Open With is unavailable on this platform.",
        ));
    }
    let prefix = if cfg!(target_os = "windows") {
        "Failed to open Windows Open with".to_string()
    } else {
        format!("Failed to open with {app_name}")
    };
    spawn_ui_command(&spec, &prefix)
}

#[cfg(all(test, target_os = "windows"))]
fn named_stream_path(path: &std::path::Path, stream: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(format!("{}:{stream}", path.display()))
}

#[cfg(test)]
fn write_named_stream(path: &std::path::Path, stream: &str, data: &[u8]) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::fs::write(named_stream_path(path, stream), data)
            .map_err(|error| fail(WINDOWS_ALTERNATE_STREAMS, error))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (path, stream, data);
        Err(fail(
            WINDOWS_ALTERNATE_STREAMS,
            "Alternate streams are only available on Windows.",
        ))
    }
}

#[cfg(test)]
fn read_named_stream(path: &std::path::Path, stream: &str) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "windows")]
    {
        std::fs::read(named_stream_path(path, stream))
            .map_err(|error| fail(WINDOWS_ALTERNATE_STREAMS, error))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (path, stream);
        Err(fail(
            WINDOWS_ALTERNATE_STREAMS,
            "Alternate streams are only available on Windows.",
        ))
    }
}

fn spawn_ui_command(spec: &NativeCommandSpec, prefix: &str) -> Result<(), String> {
    Command::new(&spec.program)
        .args(&spec.args)
        .spawn()
        .map(|_| ())
        .map_err(|error| fail(spec.adapter, format!("{prefix}: {error}")))
}

fn program_available(program: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        Command::new("where.exe")
            .args(["/Q", program])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new("/usr/bin/env")
            .args(["which", program])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }
}

#[cfg(target_os = "windows")]
pub mod windows_system_integration {
    use std::io;
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    pub const PRODUCTION_CLASS_ROOT: &str = r"HKCU\Software\Classes";

    pub fn menu_keys(class_root: &str) -> [(String, &'static str); 3] {
        [
            (format!(r"{class_root}\Directory\shell\Explorie"), "%1"),
            (format!(r"{class_root}\Drive\shell\Explorie"), "%1"),
            (
                format!(r"{class_root}\Directory\Background\shell\Explorie"),
                "%V",
            ),
        ]
    }

    fn reg() -> Command {
        let mut command = Command::new("reg.exe");
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    fn run(command: &mut Command) -> io::Result<()> {
        let output = command.output()?;
        if output.status.success() {
            Ok(())
        } else {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(io::Error::other(if detail.is_empty() {
                "reg.exe failed".to_string()
            } else {
                detail
            }))
        }
    }

    fn key_exists(key: &str) -> io::Result<bool> {
        Ok(reg()
            .args(["query", key])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?
            .success())
    }

    fn add_value(key: &str, name: Option<&str>, value: &str) -> io::Result<()> {
        let mut command = reg();
        command.args(["add", key]);
        if let Some(name) = name {
            command.args(["/v", name]);
        } else {
            command.arg("/ve");
        }
        run(command.args(["/d", value, "/f"]))
    }

    pub fn delete_key_tree(key: &str) -> io::Result<()> {
        if key_exists(key)? {
            run(reg().args(["delete", key, "/f"]))?;
        }
        Ok(())
    }

    pub fn enabled_in(class_root: &str) -> io::Result<bool> {
        for (key, _) in menu_keys(class_root) {
            if !key_exists(&key)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub fn set_enabled_in(class_root: &str, enabled: bool) -> io::Result<()> {
        if !enabled {
            for (key, _) in menu_keys(class_root) {
                delete_key_tree(&key)?;
            }
            return Ok(());
        }

        let executable = std::env::current_exe()?;
        let icon = executable.to_string_lossy();
        for (key, path_argument) in menu_keys(class_root) {
            let result = (|| {
                add_value(&key, None, "Open in Explorie")?;
                add_value(&key, Some("Icon"), &icon)?;
                add_value(
                    &format!(r"{key}\command"),
                    None,
                    &shell_command(&executable, path_argument),
                )
            })();
            if let Err(error) = result {
                let _ = set_enabled_in(class_root, false);
                return Err(error);
            }
        }
        Ok(())
    }

    pub fn enabled() -> io::Result<bool> {
        enabled_in(PRODUCTION_CLASS_ROOT)
    }

    pub fn set_enabled(enabled: bool) -> io::Result<()> {
        set_enabled_in(PRODUCTION_CLASS_ROOT, enabled)
    }

    pub fn shell_command(executable: &Path, path_argument: &str) -> String {
        format!(r#""{}" "{}""#, executable.display(), path_argument)
    }
}

#[cfg(target_os = "macos")]
mod macos_finder_tags {
    use super::{MACOS_FINDER_TAGS, fail};
    use std::ffi::CString;
    use std::fs;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const ATTR_NAME: &str = "com.apple.metadata:_kMDItemUserTags";

    pub fn get(path: &str) -> Result<Vec<String>, String> {
        let c_path =
            CString::new(path.as_bytes()).map_err(|_| fail(MACOS_FINDER_TAGS, "Invalid path"))?;
        let attr_name = CString::new(ATTR_NAME)
            .map_err(|_| fail(MACOS_FINDER_TAGS, "Invalid attribute name"))?;

        let size = unsafe {
            libc::getxattr(
                c_path.as_ptr(),
                attr_name.as_ptr(),
                std::ptr::null_mut(),
                0,
                0,
                libc::XATTR_NOFOLLOW,
            )
        };
        if size <= 0 {
            return Ok(Vec::new());
        }

        let mut buffer = vec![0u8; size as usize];
        let read_size = unsafe {
            libc::getxattr(
                c_path.as_ptr(),
                attr_name.as_ptr(),
                buffer.as_mut_ptr() as *mut libc::c_void,
                size as usize,
                0,
                libc::XATTR_NOFOLLOW,
            )
        };
        if read_size <= 0 {
            return Ok(Vec::new());
        }
        buffer.truncate(read_size as usize);
        parse_tag_plist(&buffer)
    }

    pub fn set(path: &str, tags: &[String]) -> Result<(), String> {
        let _ = Command::new("xattr").args(["-d", ATTR_NAME, path]).output();
        if tags.is_empty() {
            return Ok(());
        }

        let plist = build_tag_plist(tags);
        let temp = unique_temp("plist");
        fs::write(&temp, plist).map_err(|error| fail(MACOS_FINDER_TAGS, error))?;
        let converted = Command::new("plutil")
            .args(["-convert", "binary1"])
            .arg(&temp)
            .output()
            .map_err(|error| fail(MACOS_FINDER_TAGS, error))?;
        if !converted.status.success() {
            let _ = fs::remove_file(&temp);
            return Err(fail(MACOS_FINDER_TAGS, "Failed to convert plist to binary"));
        }

        let binary_data = fs::read(&temp).map_err(|error| fail(MACOS_FINDER_TAGS, error))?;
        let _ = fs::remove_file(&temp);

        let c_path =
            CString::new(path.as_bytes()).map_err(|_| fail(MACOS_FINDER_TAGS, "Invalid path"))?;
        let attr_name = CString::new(ATTR_NAME)
            .map_err(|_| fail(MACOS_FINDER_TAGS, "Invalid attribute name"))?;
        let result = unsafe {
            libc::setxattr(
                c_path.as_ptr(),
                attr_name.as_ptr(),
                binary_data.as_ptr() as *const libc::c_void,
                binary_data.len(),
                0,
                libc::XATTR_NOFOLLOW,
            )
        };
        if result < 0 {
            return Err(fail(MACOS_FINDER_TAGS, io_last_os_error()));
        }
        Ok(())
    }

    pub fn build_tag_plist(tags: &[String]) -> String {
        let entries = tags
            .iter()
            .map(|tag| format!("<string>{}</string>", escape_plist(tag)))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
{entries}
</array>
</plist>"#
        )
    }

    pub fn parse_plist_strings(xml: &str) -> Vec<String> {
        let mut tags = Vec::new();
        let mut rest = xml;
        while let Some(start) = rest.find("<string>") {
            rest = &rest[start + 8..];
            if let Some(end) = rest.find("</string>") {
                tags.push(unescape_plist(&rest[..end]));
                rest = &rest[end + 9..];
            } else {
                break;
            }
        }
        tags
    }

    fn parse_tag_plist(binary: &[u8]) -> Result<Vec<String>, String> {
        let temp = unique_temp("plist");
        fs::write(&temp, binary).map_err(|error| fail(MACOS_FINDER_TAGS, error))?;
        let output = Command::new("plutil")
            .args(["-convert", "xml1", "-o", "-"])
            .arg(&temp)
            .output()
            .map_err(|error| fail(MACOS_FINDER_TAGS, error));
        let _ = fs::remove_file(&temp);
        let output = output?;
        if !output.status.success() {
            return Err(fail(
                MACOS_FINDER_TAGS,
                "Failed to convert plist from binary",
            ));
        }
        Ok(parse_plist_strings(&String::from_utf8_lossy(
            &output.stdout,
        )))
    }

    fn escape_plist(value: &str) -> String {
        value
            .replace('&', "\u{26}amp;")
            .replace('<', "\u{26}lt;")
            .replace('>', "\u{26}gt;")
    }

    fn unescape_plist(value: &str) -> String {
        value
            .replace("\u{26}lt;", "<")
            .replace("\u{26}gt;", ">")
            .replace("\u{26}amp;", "&")
    }

    fn unique_temp(extension: &str) -> std::path::PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!(
            "explorie-finder-tags-{}-{}-{}.{}",
            std::process::id(),
            stamp,
            NEXT.fetch_add(1, Ordering::Relaxed),
            extension
        ))
    }

    fn io_last_os_error() -> String {
        format!("Failed to set xattr: {}", std::io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    struct NativeSkip {
        adapter: &'static str,
        reason: String,
    }

    impl NativeSkip {
        fn new(adapter: &'static str, reason: impl Into<String>) -> Self {
            Self {
                adapter,
                reason: reason.into(),
            }
        }

        fn evidence(&self) -> String {
            format!("SKIP[{}]: {}", self.adapter, self.reason)
        }
    }

    struct DisposableDir(PathBuf);

    impl DisposableDir {
        fn new(label: &str) -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "explorie-native-smoke-{label}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for DisposableDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn record_skip(adapter: &str, reason: impl std::fmt::Display) {
        eprintln!("SKIP[{adapter}]: {reason}");
    }

    #[test]
    fn system_integration_status_serializes_camel_case() {
        let json = serde_json::to_value(SystemIntegrationStatus {
            supported: true,
            enabled: false,
        })
        .unwrap();
        assert_eq!(json["supported"], true);
        assert_eq!(json["enabled"], false);
    }

    #[test]
    fn windows_system_integration_disposable_fixture() {
        let status = system_integration_status().expect(WINDOWS_SYSTEM_INTEGRATION);
        let json = serde_json::to_value(&status).expect(WINDOWS_SYSTEM_INTEGRATION);
        assert_eq!(json["supported"], cfg!(target_os = "windows"));

        #[cfg(target_os = "windows")]
        {
            let root = format!(
                r"HKCU\Software\Explorie\NativeSmoke\{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_nanos())
                    .unwrap_or_default()
            );
            struct Guard(String);
            impl Drop for Guard {
                fn drop(&mut self) {
                    let _ = windows_system_integration::delete_key_tree(&self.0);
                    let _ = windows_system_integration::delete_key_tree(
                        r"HKCU\Software\Explorie\NativeSmoke",
                    );
                }
            }
            let _guard = Guard(root.clone());

            assert!(
                !windows_system_integration::enabled_in(&root).expect(WINDOWS_SYSTEM_INTEGRATION),
                "{WINDOWS_SYSTEM_INTEGRATION}: disposable keys must start absent"
            );
            windows_system_integration::set_enabled_in(&root, true)
                .expect(WINDOWS_SYSTEM_INTEGRATION);
            assert!(
                windows_system_integration::enabled_in(&root).expect(WINDOWS_SYSTEM_INTEGRATION),
                "{WINDOWS_SYSTEM_INTEGRATION}: disposable keys must enable"
            );
            windows_system_integration::set_enabled_in(&root, false)
                .expect(WINDOWS_SYSTEM_INTEGRATION);
            assert!(
                !windows_system_integration::enabled_in(&root).expect(WINDOWS_SYSTEM_INTEGRATION),
                "{WINDOWS_SYSTEM_INTEGRATION}: disposable keys must disable"
            );
            assert_eq!(
                windows_system_integration::shell_command(
                    Path::new(r"C:\Program Files\Explorie\explorie.exe"),
                    "%1"
                ),
                r#""C:\Program Files\Explorie\explorie.exe" "%1""#
            );
        }

        #[cfg(not(target_os = "windows"))]
        {
            assert!(!status.supported);
            assert!(!status.enabled);
            let error = set_system_integration(true).expect_err(WINDOWS_SYSTEM_INTEGRATION);
            assert!(error.contains(WINDOWS_SYSTEM_INTEGRATION), "{error}");
            record_skip(WINDOWS_SYSTEM_INTEGRATION, error);
        }
    }

    #[test]
    fn windows_alternate_stream_disposable_round_trip() {
        let fixture = DisposableDir::new("ads");
        let file = fixture.path().join("note.txt");
        fs::write(&file, b"primary").expect(WINDOWS_ALTERNATE_STREAMS);

        #[cfg(target_os = "windows")]
        {
            write_named_stream(&file, "explorie", b"alternate").expect(WINDOWS_ALTERNATE_STREAMS);
            assert_eq!(
                read_named_stream(&file, "explorie").expect(WINDOWS_ALTERNATE_STREAMS),
                b"alternate"
            );
            assert_eq!(
                fs::read(&file).expect(WINDOWS_ALTERNATE_STREAMS),
                b"primary"
            );
        }

        #[cfg(not(target_os = "windows"))]
        {
            let error = write_named_stream(&file, "explorie", b"alternate")
                .expect_err(WINDOWS_ALTERNATE_STREAMS);
            assert!(error.contains(WINDOWS_ALTERNATE_STREAMS), "{error}");
            record_skip(WINDOWS_ALTERNATE_STREAMS, error);
        }
    }

    #[test]
    fn macos_finder_tag_colors_serialize_and_map() {
        let colors = finder_tag_colors();
        assert_eq!(colors.get("None"), Some(&0));
        assert_eq!(colors.get("Red"), Some(&6));
        assert_eq!(colors.get("Orange"), Some(&7));
        let json = serde_json::to_value(&colors).expect(MACOS_FINDER_TAG_COLORS);
        assert_eq!(json["Blue"], 4);
        assert_eq!(json["Yellow"], 5);
    }

    #[test]
    fn macos_finder_tags_disposable_round_trip() {
        let fixture = DisposableDir::new("finder-tags");
        let file = fixture.path().join("note.txt");
        fs::write(&file, b"tags").expect(MACOS_FINDER_TAGS);
        let path = file.to_string_lossy();

        #[cfg(target_os = "macos")]
        {
            assert_eq!(
                get_finder_tags(&path).expect(MACOS_FINDER_TAGS),
                Vec::<String>::new()
            );
            set_finder_tags(
                &path,
                &[
                    "Work".to_string(),
                    "Important\n6".to_string(),
                    "A & B <C>".to_string(),
                ],
            )
            .expect(MACOS_FINDER_TAGS);
            let tags = get_finder_tags(&path).expect(MACOS_FINDER_TAGS);
            assert!(
                tags.contains(&"Work".to_string()),
                "{MACOS_FINDER_TAGS}: {tags:?}"
            );
            assert!(
                tags.contains(&"Important\n6".to_string()),
                "{MACOS_FINDER_TAGS}: {tags:?}"
            );
            assert_eq!(
                finder_tag_colors().get("Red").copied(),
                Some(6),
                "{MACOS_FINDER_TAG_COLORS}: Red must map to suffix 6"
            );
            assert!(
                tags.contains(&"A & B <C>".to_string()),
                "{MACOS_FINDER_TAGS}: {tags:?}"
            );
            set_finder_tags(&path, &[]).expect(MACOS_FINDER_TAGS);
            assert_eq!(
                get_finder_tags(&path).expect(MACOS_FINDER_TAGS),
                Vec::<String>::new()
            );

            let plist = macos_finder_tags::build_tag_plist(&["Red\n6".to_string()]);
            assert_eq!(
                macos_finder_tags::parse_plist_strings(&plist),
                vec!["Red\n6".to_string()]
            );
        }

        #[cfg(not(target_os = "macos"))]
        {
            assert_eq!(
                get_finder_tags(&path).expect(MACOS_FINDER_TAGS),
                Vec::<String>::new()
            );
            let error = set_finder_tags(&path, &["Work".to_string()]).expect_err(MACOS_FINDER_TAGS);
            assert!(error.contains(MACOS_FINDER_TAGS), "{error}");
            record_skip(MACOS_FINDER_TAGS, error);
        }
    }

    #[test]
    fn macos_helper_status_is_known_or_explicitly_skipped() {
        match crate::remote_drives::macos_helper_status() {
            Some(status) => {
                assert!(
                    matches!(
                        status.as_str(),
                        "not-registered" | "enabled" | "approval-required" | "unavailable"
                    ),
                    "{MACOS_HELPER_STATUS}: unexpected {status}"
                );
                let json = serde_json::json!({ "helperStatus": status.clone() });
                assert_eq!(json["helperStatus"], status);
            }
            None => {
                let error =
                    crate::remote_drives::register_macos_helper().expect_err(MACOS_HELPER_STATUS);
                assert!(
                    error.to_ascii_lowercase().contains("macos"),
                    "{MACOS_HELPER_STATUS}: {error}"
                );
                record_skip(MACOS_HELPER_STATUS, error);
            }
        }
        assert_eq!(
            crate::remote_drives::map_macos_helper_status(0),
            "not-registered"
        );
        assert_eq!(crate::remote_drives::map_macos_helper_status(1), "enabled");
        assert_eq!(
            crate::remote_drives::map_macos_helper_status(2),
            "approval-required"
        );
        assert_eq!(
            crate::remote_drives::map_macos_helper_status(99),
            "unavailable"
        );
    }

    #[test]
    fn quick_look_arguments_and_availability_do_not_open_ui() {
        let spec = quick_look_spec("/tmp/explorie-smoke.txt");
        assert_eq!(spec.adapter, MACOS_QUICK_LOOK);
        assert_eq!(spec.args, ["-p", "/tmp/explorie-smoke.txt"]);
        assert!(spec.presents_ui);
        assert_eq!(spec.program, "qlmanage");

        #[cfg(target_os = "macos")]
        {
            assert!(
                spec.available,
                "{MACOS_QUICK_LOOK}: qlmanage must be available on matching macOS runners"
            );
        }

        #[cfg(not(target_os = "macos"))]
        {
            assert!(!spec.available);
            let error = launch_quick_look("/tmp/explorie-smoke.txt").expect_err(MACOS_QUICK_LOOK);
            assert!(error.contains(MACOS_QUICK_LOOK), "{error}");
            record_skip(MACOS_QUICK_LOOK, error);
        }
    }

    #[test]
    fn open_with_arguments_and_availability_do_not_open_ui() {
        let spec = open_with_spec("/tmp/explorie-smoke.txt", "Preview");
        assert_eq!(spec.adapter, OPEN_WITH);
        assert!(spec.presents_ui);

        #[cfg(target_os = "macos")]
        {
            assert_eq!(spec.program, "open");
            assert_eq!(spec.args, ["-a", "Preview", "/tmp/explorie-smoke.txt"]);
            assert!(
                spec.available,
                "{OPEN_WITH}: open must be available on matching macOS runners"
            );
        }

        #[cfg(target_os = "windows")]
        {
            assert_eq!(spec.program, "rundll32.exe");
            assert_eq!(
                spec.args,
                ["shell32.dll,OpenAs_RunDLL", "/tmp/explorie-smoke.txt"]
            );
            assert!(
                spec.available,
                "{OPEN_WITH}: rundll32.exe must be available on matching Windows runners"
            );
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            assert!(!spec.available);
            let error =
                launch_open_with("/tmp/explorie-smoke.txt", "Preview").expect_err(OPEN_WITH);
            assert!(error.contains(OPEN_WITH), "{error}");
            record_skip(OPEN_WITH, error);
        }
    }

    #[test]
    fn native_skip_evidence_names_the_adapter() {
        let skip = NativeSkip::new(MACOS_QUICK_LOOK, "Quick Look is only available on macOS.");
        assert_eq!(
            skip.evidence(),
            "SKIP[macos_quick_look]: Quick Look is only available on macOS."
        );
    }
}
