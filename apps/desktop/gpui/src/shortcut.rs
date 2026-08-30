use std::collections::{BTreeMap, BTreeSet};

use gpui::{KeyBinding, Keystroke};

use crate::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ShortcutDefinition {
    pub(crate) id: &'static str,
    pub(crate) label: &'static str,
    pub(crate) category: &'static str,
    pub(crate) default_binding: &'static str,
}

pub(crate) const EDITABLE_SHORTCUTS: &[ShortcutDefinition] = &[
    definition("nav-back", "Go back", "Navigation", "alt-left"),
    definition("nav-forward", "Go forward", "Navigation", "alt-right"),
    definition("nav-up", "Go up one directory", "Navigation", "alt-up"),
    definition(
        "nav-go-to-folder",
        "Go to folder",
        "Navigation",
        "secondary-g",
    ),
    definition(
        "nav-toggle-favorite",
        "Toggle favorite",
        "Navigation",
        "secondary-d",
    ),
    definition(
        "search-focus",
        "Search filenames",
        "Navigation",
        "secondary-f",
    ),
    definition(
        "search-save-smart-folder",
        "Save smart folder",
        "Navigation",
        "secondary-shift-g",
    ),
    definition(
        "file-copy",
        "Copy selected items",
        "File operations",
        "secondary-c",
    ),
    definition(
        "file-cut",
        "Cut selected items",
        "File operations",
        "secondary-x",
    ),
    definition(
        "file-paste",
        "Paste items",
        "File operations",
        "secondary-v",
    ),
    definition(
        "file-trash",
        "Move selected items to trash",
        "File operations",
        "delete",
    ),
    definition(
        "file-delete-permanently",
        "Delete permanently",
        "File operations",
        "shift-delete",
    ),
    definition(
        "file-new-folder",
        "New folder",
        "File operations",
        "secondary-shift-n",
    ),
    definition(
        "file-rename",
        "Rename selected item",
        "File operations",
        "f2",
    ),
    definition("edit-undo", "Undo", "File operations", "secondary-z"),
    definition("edit-redo", "Redo", "File operations", "secondary-y"),
    definition("view-refresh", "Refresh", "View", "f5"),
    definition(
        "view-toggle-hidden",
        "Toggle hidden files",
        "View",
        "secondary-h",
    ),
    definition("view-list", "List view", "View", "secondary-1"),
    definition("view-grid", "Grid view", "View", "secondary-2"),
    definition("view-column", "Column view", "View", "secondary-3"),
    definition("window-new", "New window", "Tabs", "secondary-n"),
    definition("tab-new", "New tab", "Tabs", "secondary-t"),
    definition("tab-close", "Close tab or window", "Tabs", "secondary-w"),
    definition("tab-next", "Next tab", "Tabs", "secondary-tab"),
    definition(
        "tab-previous",
        "Previous tab",
        "Tabs",
        "secondary-shift-tab",
    ),
    definition("settings-open", "Open settings", "Settings", "secondary-,"),
    definition(
        "commands-open",
        "Open command palette",
        "Settings",
        "secondary-shift-p",
    ),
    definition(
        "workspace-manager",
        "Manage workspaces",
        "Settings",
        "secondary-shift-w",
    ),
    definition(
        "remote-drives-manager",
        "Manage remote drives",
        "Settings",
        "secondary-shift-r",
    ),
    definition(
        "help-shortcuts",
        "Show keyboard shortcuts",
        "Help",
        "shift-/",
    ),
    definition(
        "help-diagnostics",
        "Show diagnostics",
        "Help",
        "secondary-alt-d",
    ),
];

const fn definition(
    id: &'static str,
    label: &'static str,
    category: &'static str,
    default_binding: &'static str,
) -> ShortcutDefinition {
    ShortcutDefinition {
        id,
        label,
        category,
        default_binding,
    }
}

pub(crate) fn effective_binding<'a>(
    overrides: &'a BTreeMap<String, String>,
    id: &str,
    default_binding: &'static str,
) -> &'a str {
    overrides
        .get(id)
        .map(String::as_str)
        .unwrap_or(default_binding)
}

pub(crate) fn binding_for(overrides: &BTreeMap<String, String>, id: &str) -> Option<String> {
    EDITABLE_SHORTCUTS
        .iter()
        .find(|shortcut| shortcut.id == id)
        .map(|shortcut| {
            effective_binding(overrides, shortcut.id, shortcut.default_binding).to_string()
        })
}

pub(crate) fn display_binding(binding: &str) -> String {
    let macos = cfg!(target_os = "macos");
    let parts = binding
        .split('-')
        .map(|part| match part {
            "secondary" if macos => "⌘".to_string(),
            "secondary" => "Ctrl".to_string(),
            "alt" if macos => "⌥".to_string(),
            "alt" => "Alt".to_string(),
            "shift" if macos => "⇧".to_string(),
            "shift" => "Shift".to_string(),
            "left" if macos => "←".to_string(),
            "left" => "Left".to_string(),
            "right" if macos => "→".to_string(),
            "right" => "Right".to_string(),
            "up" if macos => "↑".to_string(),
            "up" => "Up".to_string(),
            "down" if macos => "↓".to_string(),
            "down" => "Down".to_string(),
            "delete" if macos => "⌦".to_string(),
            "delete" => "Delete".to_string(),
            "backspace" if macos => "⌫".to_string(),
            "backspace" => "Backspace".to_string(),
            "tab" => "Tab".to_string(),
            "enter" if macos => "↩".to_string(),
            "enter" => "Enter".to_string(),
            "space" => "Space".to_string(),
            key if key.len() == 1 => key.to_ascii_uppercase(),
            key if key.starts_with('f') && key[1..].chars().all(|c| c.is_ascii_digit()) => {
                key.to_ascii_uppercase()
            }
            key => key.to_string(),
        })
        .collect::<Vec<_>>();
    parts.join(if macos { "" } else { " + " })
}

pub(crate) fn binding_from_keystroke(keystroke: &Keystroke) -> Option<String> {
    if matches!(
        keystroke.key.as_str(),
        "control" | "shift" | "alt" | "platform" | "function"
    ) {
        return None;
    }
    let mut parts = Vec::with_capacity(4);
    if keystroke.modifiers.control || keystroke.modifiers.platform {
        parts.push("secondary".to_string());
    }
    if keystroke.modifiers.alt {
        parts.push("alt".to_string());
    }
    if keystroke.modifiers.shift {
        parts.push("shift".to_string());
    }
    parts.push(keystroke.key.to_ascii_lowercase());
    Some(parts.join("-"))
}

pub(crate) fn validate_shortcut_overrides(
    overrides: &BTreeMap<String, String>,
) -> Result<(), String> {
    let known: BTreeSet<_> = EDITABLE_SHORTCUTS.iter().map(|item| item.id).collect();
    for (id, binding) in overrides {
        if !known.contains(id.as_str()) {
            return Err(format!("unknown shortcut command: {id}"));
        }
        if binding.len() > 64 || binding.chars().any(char::is_control) {
            return Err(format!(
                "shortcut for {id} is not a bounded printable value"
            ));
        }
        Keystroke::parse(binding).map_err(|_| format!("shortcut for {id} is invalid"))?;
    }

    let mut used = BTreeMap::<String, String>::new();
    for (binding, label) in fixed_browser_bindings() {
        used.insert(binding.to_string(), label.to_string());
    }
    for shortcut in EDITABLE_SHORTCUTS {
        let binding = effective_binding(overrides, shortcut.id, shortcut.default_binding)
            .to_ascii_lowercase();
        if matches!(binding.as_str(), "space" | "escape") {
            return Err(format!(
                "{} is reserved for native preview/dismiss behavior",
                display_binding(&binding)
            ));
        }
        if let Some(existing) = used.insert(binding.clone(), shortcut.label.to_string()) {
            return Err(format!(
                "{} conflicts with {existing}",
                display_binding(&binding)
            ));
        }
    }
    Ok(())
}

pub(crate) fn fixed_browser_bindings() -> &'static [(&'static str, &'static str)] {
    &[
        ("down", "file navigation"),
        ("up", "file navigation"),
        ("shift-down", "range selection"),
        ("shift-up", "range selection"),
        ("secondary-a", "select all"),
        ("enter", "open selected item"),
        ("space", "preview selected item"),
        ("secondary-space", "retry preview"),
        ("secondary-shift-space", "close preview"),
        ("escape", "dismiss or clear selection"),
        ("left", "column/grid navigation"),
        ("right", "column/grid navigation"),
        ("secondary-shift-left", "move tab left"),
        ("secondary-shift-right", "move tab right"),
        ("secondary-shift-f", "cycle file filter"),
        ("secondary-shift-s", "toggle folder sizes"),
        ("secondary-+", "increase UI scale"),
        ("secondary--", "decrease UI scale"),
        ("secondary-0", "reset UI scale"),
        ("secondary-alt-shift-p", "clear preview cache"),
        ("secondary-alt-p", "refresh preview helpers"),
        ("secondary-alt-a", "create archive"),
        ("secondary-alt-e", "extract archive"),
        ("secondary-alt-i", "inspect archive"),
        ("secondary-alt-shift-i", "close archive inspection"),
        ("secondary-alt-f", "cycle archive format"),
        ("secondary-alt-c", "cycle archive compression"),
        ("secondary-escape", "cancel operation"),
        ("secondary-shift-backspace", "clear completed operations"),
        ("secondary-shift-c", "cycle conflict policy"),
        ("secondary-alt-n", "new note"),
        ("secondary-alt-l", "new website link"),
        ("secondary-alt-r", "retry operation"),
    ]
}

pub fn application_key_bindings(overrides: &BTreeMap<String, String>) -> Vec<KeyBinding> {
    let key = |id, default| effective_binding(overrides, id, default);
    vec![
        KeyBinding::new(key("nav-back", "alt-left"), GoBack, Some("browser")),
        KeyBinding::new(key("nav-forward", "alt-right"), GoForward, Some("browser")),
        KeyBinding::new(key("nav-up", "alt-up"), GoUp, Some("browser")),
        KeyBinding::new(
            key("nav-go-to-folder", "secondary-g"),
            GoToFolder,
            Some("browser"),
        ),
        KeyBinding::new("alt-up", MoveFavoriteUp, Some("favorite")),
        KeyBinding::new("alt-down", MoveFavoriteDown, Some("favorite")),
        KeyBinding::new(key("view-refresh", "f5"), Refresh, Some("browser")),
        KeyBinding::new(
            key("view-toggle-hidden", "secondary-h"),
            ToggleHidden,
            Some("browser"),
        ),
        KeyBinding::new("secondary-shift-f", CycleFilter, Some("browser")),
        KeyBinding::new("down", SelectNext, Some("browser")),
        KeyBinding::new("up", SelectPrevious, Some("browser")),
        KeyBinding::new("shift-down", SelectNextRange, Some("browser")),
        KeyBinding::new("shift-up", SelectPreviousRange, Some("browser")),
        KeyBinding::new("secondary-a", SelectAll, Some("browser")),
        KeyBinding::new("enter", OpenSelected, Some("browser")),
        KeyBinding::new("secondary-space", RetryPreview, Some("browser")),
        KeyBinding::new("secondary-shift-space", ClosePreview, Some("browser")),
        KeyBinding::new("secondary-alt-shift-p", ClearPreviewCache, Some("browser")),
        KeyBinding::new("secondary-alt-p", RefreshPreviewHelpers, Some("browser")),
        KeyBinding::new("escape", ClearSelection, Some("browser")),
        KeyBinding::new(
            key("view-list", "secondary-1"),
            ShowListView,
            Some("browser"),
        ),
        KeyBinding::new(
            key("view-grid", "secondary-2"),
            ShowGridView,
            Some("browser"),
        ),
        KeyBinding::new(
            key("view-column", "secondary-3"),
            ShowColumnView,
            Some("browser"),
        ),
        KeyBinding::new("left", ColumnLeft, Some("browser")),
        KeyBinding::new("right", ColumnRight, Some("browser")),
        KeyBinding::new(
            key("search-focus", "secondary-f"),
            FocusSearch,
            Some("browser"),
        ),
        KeyBinding::new(
            key("search-save-smart-folder", "secondary-shift-g"),
            SaveSearch,
            Some("browser"),
        ),
        KeyBinding::new("secondary-shift-s", ToggleFolderSizes, Some("browser")),
        KeyBinding::new("secondary-+", IncreaseUiScale, None),
        KeyBinding::new("secondary--", DecreaseUiScale, None),
        KeyBinding::new("secondary-0", ResetUiScale, None),
        KeyBinding::new(key("window-new", "secondary-n"), NewWindow, Some("browser")),
        KeyBinding::new(key("tab-new", "secondary-t"), NewTab, Some("browser")),
        KeyBinding::new(key("tab-close", "secondary-w"), CloseTab, Some("browser")),
        KeyBinding::new(key("tab-next", "secondary-tab"), NextTab, Some("browser")),
        KeyBinding::new(
            key("tab-previous", "secondary-shift-tab"),
            PreviousTab,
            Some("browser"),
        ),
        KeyBinding::new("secondary-shift-left", MoveTabLeft, Some("browser")),
        KeyBinding::new("secondary-shift-right", MoveTabRight, Some("browser")),
        KeyBinding::new(
            key("nav-toggle-favorite", "secondary-d"),
            ToggleFavorite,
            Some("browser"),
        ),
        KeyBinding::new(
            key("file-copy", "secondary-c"),
            CopySelected,
            Some("browser"),
        ),
        KeyBinding::new(key("file-cut", "secondary-x"), CutSelected, Some("browser")),
        KeyBinding::new(key("file-paste", "secondary-v"), Paste, Some("browser")),
        KeyBinding::new(key("file-trash", "delete"), TrashSelected, Some("browser")),
        KeyBinding::new(
            key("file-delete-permanently", "shift-delete"),
            PermanentDeleteSelected,
            Some("browser"),
        ),
        KeyBinding::new("secondary-alt-a", CreateArchive, Some("browser")),
        KeyBinding::new("secondary-alt-e", ExtractArchive, Some("browser")),
        KeyBinding::new("secondary-alt-i", InspectArchive, Some("browser")),
        KeyBinding::new(
            "secondary-alt-shift-i",
            CloseArchiveInspection,
            Some("browser"),
        ),
        KeyBinding::new("secondary-alt-f", CycleArchiveFormat, Some("browser")),
        KeyBinding::new("secondary-alt-c", CycleArchiveCompression, Some("browser")),
        KeyBinding::new("secondary-escape", CancelOperation, Some("browser")),
        KeyBinding::new(
            "secondary-shift-backspace",
            ClearCompletedOperations,
            Some("browser"),
        ),
        KeyBinding::new("secondary-shift-c", CycleConflictPolicy, Some("browser")),
        KeyBinding::new(
            key("file-new-folder", "secondary-shift-n"),
            NewFolder,
            Some("browser"),
        ),
        KeyBinding::new("secondary-alt-n", NewNote, Some("browser")),
        KeyBinding::new(key("file-rename", "f2"), RenameSelected, Some("browser")),
        KeyBinding::new("secondary-alt-l", NewWebsiteLink, Some("browser")),
        KeyBinding::new("secondary-alt-r", RetryOperation, Some("browser")),
        KeyBinding::new(key("edit-undo", "secondary-z"), Undo, Some("browser")),
        KeyBinding::new(key("edit-redo", "secondary-y"), Redo, Some("browser")),
        KeyBinding::new(
            key("settings-open", "secondary-,"),
            ToggleSettingsPanel,
            Some("browser"),
        ),
        KeyBinding::new(
            key("commands-open", "secondary-shift-p"),
            OpenCommandPalette,
            Some("browser"),
        ),
        KeyBinding::new(
            key("workspace-manager", "secondary-shift-w"),
            ToggleWorkspaceManager,
            Some("browser"),
        ),
        KeyBinding::new(
            key("remote-drives-manager", "secondary-shift-r"),
            ToggleRemoteDriveManager,
            Some("browser"),
        ),
        KeyBinding::new(
            key("help-shortcuts", "shift-/"),
            ToggleShortcutsOverlay,
            Some("browser"),
        ),
        KeyBinding::new(
            key("help-diagnostics", "secondary-alt-d"),
            ToggleDiagnostics,
            Some("browser"),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_validation_refuses_conflicts_reserved_keys_and_unknown_commands() {
        assert!(validate_shortcut_overrides(&BTreeMap::new()).is_ok());
        assert!(
            validate_shortcut_overrides(&BTreeMap::from([(
                "nav-back".to_string(),
                "space".to_string()
            )]))
            .unwrap_err()
            .contains("reserved")
        );
        assert!(
            validate_shortcut_overrides(&BTreeMap::from([(
                "nav-back".to_string(),
                "secondary-c".to_string()
            )]))
            .unwrap_err()
            .contains("conflicts")
        );
        assert!(
            validate_shortcut_overrides(&BTreeMap::from([(
                "unknown".to_string(),
                "secondary-k".to_string()
            )]))
            .unwrap_err()
            .contains("unknown")
        );
    }

    #[test]
    fn binding_display_and_capture_are_canonical() {
        let key = Keystroke::parse("ctrl-alt-b").unwrap();
        assert_eq!(
            binding_from_keystroke(&key).as_deref(),
            Some("secondary-alt-b")
        );
        assert_eq!(
            display_binding("secondary-alt-b"),
            if cfg!(target_os = "macos") {
                "⌘⌥B"
            } else {
                "Ctrl + Alt + B"
            }
        );
    }

    #[test]
    fn plain_space_is_owned_only_by_the_native_preview_handler() {
        let space = Keystroke::parse("space").unwrap();
        assert!(
            application_key_bindings(&BTreeMap::new())
                .iter()
                .all(
                    |binding| binding.match_keystrokes(std::slice::from_ref(&space)) != Some(false)
                )
        );
        assert!(fixed_browser_bindings().contains(&("space", "preview selected item")));
    }

    #[test]
    fn ui_scale_shortcuts_are_global_and_reserved_from_rebinding() {
        let bindings = application_key_bindings(&BTreeMap::new());
        let modifier = if cfg!(target_os = "macos") {
            "cmd"
        } else {
            "ctrl"
        };
        for key in ["+", "-", "0"] {
            let key = Keystroke::parse(&format!("{modifier}-{key}")).unwrap();
            assert!(bindings.iter().any(|binding| {
                binding.match_keystrokes(std::slice::from_ref(&key)) == Some(false)
            }));
        }
        assert!(fixed_browser_bindings().contains(&("secondary-+", "increase UI scale")));
        assert!(fixed_browser_bindings().contains(&("secondary--", "decrease UI scale")));
        assert!(fixed_browser_bindings().contains(&("secondary-0", "reset UI scale")));
    }
}
