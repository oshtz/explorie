#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CommandId {
    GoBack,
    GoForward,
    GoUp,
    GoToFolder,
    ClearHistory,
    Refresh,
    ListView,
    GridView,
    ColumnView,
    ToggleHidden,
    TogglePreview,
    ToggleStatus,
    NewWindow,
    MoveTabToNewWindow,
    NewTab,
    CloseTab,
    NewFolder,
    Rename,
    Copy,
    Cut,
    Paste,
    Trash,
    Undo,
    Redo,
    OpenSettings,
    ManageWorkspaces,
    SaveWorkspace,
    ManageRemoteDrives,
    ThemeDark,
    ThemeLight,
    ThemeSystem,
    ToggleFavorite,
    SaveSmartFolder,
    ShowShortcuts,
    ShowDiagnostics,
}

impl CommandId {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::GoBack => "nav-back",
            Self::GoForward => "nav-forward",
            Self::GoUp => "nav-up",
            Self::GoToFolder => "nav-go-to-folder",
            Self::ClearHistory => "nav-clear-history",
            Self::Refresh => "view-refresh",
            Self::ListView => "view-list",
            Self::GridView => "view-grid",
            Self::ColumnView => "view-column",
            Self::ToggleHidden => "view-toggle-hidden",
            Self::TogglePreview => "view-toggle-preview",
            Self::ToggleStatus => "view-toggle-status",
            Self::NewWindow => "window-new",
            Self::MoveTabToNewWindow => "window-move-tab",
            Self::NewTab => "tab-new",
            Self::CloseTab => "tab-close",
            Self::NewFolder => "file-new-folder",
            Self::Rename => "file-rename",
            Self::Copy => "file-copy",
            Self::Cut => "file-cut",
            Self::Paste => "file-paste",
            Self::Trash => "file-trash",
            Self::Undo => "edit-undo",
            Self::Redo => "edit-redo",
            Self::OpenSettings => "settings-open",
            Self::ManageWorkspaces => "workspace-manager",
            Self::SaveWorkspace => "workspace-save",
            Self::ManageRemoteDrives => "remote-drives-manager",
            Self::ThemeDark => "settings-theme-dark",
            Self::ThemeLight => "settings-theme-light",
            Self::ThemeSystem => "settings-theme-system",
            Self::ToggleFavorite => "nav-toggle-favorite",
            Self::SaveSmartFolder => "search-save-smart-folder",
            Self::ShowShortcuts => "help-shortcuts",
            Self::ShowDiagnostics => "help-diagnostics",
        }
    }

    pub(crate) fn from_str(value: &str) -> Option<Self> {
        all_commands(CommandContext::default())
            .into_iter()
            .find(|command| command.id.as_str() == value)
            .map(|command| command.id)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CommandCategory {
    Navigation,
    File,
    View,
    Tabs,
    Settings,
    Help,
}

impl CommandCategory {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Navigation => "Navigation",
            Self::File => "File operations",
            Self::View => "View",
            Self::Tabs => "Tabs",
            Self::Settings => "Settings",
            Self::Help => "Help",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CommandSpec {
    pub(crate) id: CommandId,
    pub(crate) name: String,
    pub(crate) shortcut: Option<String>,
    pub(crate) category: CommandCategory,
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct CommandContext {
    pub(crate) show_hidden: bool,
    pub(crate) show_preview: bool,
    pub(crate) show_status: bool,
    pub(crate) favorite: bool,
}

pub(crate) fn all_commands(context: CommandContext) -> Vec<CommandSpec> {
    use CommandCategory::{File, Help, Navigation, Settings, Tabs, View};
    use CommandId::*;
    vec![
        command(GoBack, "Go back", Some("Alt+Left"), Navigation),
        command(GoForward, "Go forward", Some("Alt+Right"), Navigation),
        command(GoUp, "Go up one directory", Some("Alt+Up"), Navigation),
        command(GoToFolder, "Go to folder…", Some("Ctrl+G"), Navigation),
        command(ClearHistory, "Clear navigation history", None, Navigation),
        command(
            ToggleFavorite,
            if context.favorite {
                "Remove current folder from favorites"
            } else {
                "Add current folder to favorites"
            },
            Some("Ctrl+D"),
            Navigation,
        ),
        command(
            SaveSmartFolder,
            "Save current search as smart folder",
            Some("Ctrl+Shift+G"),
            Navigation,
        ),
        command(NewFolder, "New folder", Some("Ctrl+Shift+N"), File),
        command(Rename, "Rename selected item", Some("F2"), File),
        command(Copy, "Copy selected items", Some("Ctrl+C"), File),
        command(Cut, "Cut selected items", Some("Ctrl+X"), File),
        command(Paste, "Paste items", Some("Ctrl+V"), File),
        command(Trash, "Move selected items to trash", Some("Delete"), File),
        command(Undo, "Undo", Some("Ctrl+Z"), File),
        command(Redo, "Redo", Some("Ctrl+Y"), File),
        command(
            NewWindow,
            "Open current folder in new window",
            Some("Ctrl+N"),
            Tabs,
        ),
        command(
            MoveTabToNewWindow,
            "Move current tab to new window",
            None,
            Tabs,
        ),
        command(Refresh, "Refresh", Some("F5"), View),
        command(ListView, "Switch to list view", Some("Ctrl+1"), View),
        command(GridView, "Switch to grid view", Some("Ctrl+2"), View),
        command(ColumnView, "Switch to column view", Some("Ctrl+3"), View),
        command(
            ToggleHidden,
            if context.show_hidden {
                "Hide hidden files"
            } else {
                "Show hidden files"
            },
            Some("Ctrl+H"),
            View,
        ),
        command(
            TogglePreview,
            if context.show_preview {
                "Unpin preview panel"
            } else {
                "Pin preview panel"
            },
            None,
            View,
        ),
        command(
            ToggleStatus,
            if context.show_status {
                "Hide status bar"
            } else {
                "Show status bar"
            },
            None,
            View,
        ),
        command(NewTab, "New tab", Some("Ctrl+T"), Tabs),
        command(CloseTab, "Close current tab", Some("Ctrl+W"), Tabs),
        command(OpenSettings, "Open settings", Some("Ctrl+,"), Settings),
        command(
            ManageWorkspaces,
            "Manage workspaces",
            Some("Ctrl+Shift+W"),
            Settings,
        ),
        command(SaveWorkspace, "Save current workspace", None, Settings),
        command(
            ManageRemoteDrives,
            "Manage remote drives",
            Some("Ctrl+Shift+R"),
            Settings,
        ),
        command(ThemeDark, "Switch to dark theme", None, Settings),
        command(ThemeLight, "Switch to light theme", None, Settings),
        command(ThemeSystem, "Use system theme", None, Settings),
        command(ShowShortcuts, "Show keyboard shortcuts", Some("?"), Help),
        command(
            ShowDiagnostics,
            "Show native diagnostics",
            Some("Ctrl+Alt+D"),
            Help,
        ),
    ]
}

fn command(
    id: CommandId,
    name: &str,
    shortcut: Option<&'static str>,
    category: CommandCategory,
) -> CommandSpec {
    CommandSpec {
        id,
        name: name.to_string(),
        shortcut: shortcut.map(str::to_string),
        category,
    }
}

pub(crate) fn filtered_commands(query: &str, commands: &[CommandSpec]) -> Vec<CommandSpec> {
    let query = query.trim();
    if query.is_empty() {
        return commands.to_vec();
    }
    let mut matches: Vec<_> = commands
        .iter()
        .filter_map(|command| {
            let name_score = fuzzy_score(query, &command.name);
            let category_score =
                fuzzy_score(query, command.category.label()).map(|score| score / 2);
            name_score
                .max(category_score)
                .map(|score| (score, command.clone()))
        })
        .collect();
    matches.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .cmp(left_score)
            .then_with(|| left.name.cmp(&right.name))
    });
    matches.into_iter().map(|(_, command)| command).collect()
}

fn fuzzy_score(query: &str, target: &str) -> Option<u32> {
    let query = query.to_lowercase();
    let target = target.to_lowercase();
    if query.is_empty() {
        return Some(0);
    }
    let mut query_chars = query.chars();
    let mut expected = query_chars.next()?;
    let mut score = 0;
    let mut consecutive = 0;
    for character in target.chars() {
        if character == expected {
            score += 1 + consecutive;
            consecutive += 1;
            if let Some(next) = query_chars.next() {
                expected = next;
            } else {
                if target.starts_with(&query) {
                    score += 10;
                }
                return Some(score);
            }
        } else {
            consecutive = 0;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fuzzy_filter_matches_in_order_and_ranks_prefixes_first() {
        let commands = all_commands(CommandContext::default());
        let filtered = filtered_commands("theme", &commands);
        assert_eq!(filtered.len(), 3);
        assert!(
            filtered
                .iter()
                .all(|command| command.name.contains("theme"))
        );

        let filtered = filtered_commands("diag", &commands);
        assert_eq!(filtered[0].id, CommandId::ShowDiagnostics);
        assert!(filtered_commands("not-a-command", &commands).is_empty());
    }

    #[test]
    fn command_ids_round_trip_for_persistent_recents() {
        for command in all_commands(CommandContext::default()) {
            assert_eq!(CommandId::from_str(command.id.as_str()), Some(command.id));
        }
    }

    #[test]
    fn command_palette_advertises_native_bindings() {
        let commands = all_commands(CommandContext::default());
        assert_eq!(
            commands
                .iter()
                .find(|command| command.id == CommandId::OpenSettings)
                .and_then(|command| command.shortcut.as_deref()),
            Some("Ctrl+,")
        );
        assert!(
            commands
                .iter()
                .all(|command| command.name != "Go to folder")
        );
    }
}
