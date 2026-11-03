-- App preferences are applied explicitly, never as a side effect of config reload.
local preferences = {
  -- Approved explicitly: allow app actions, without adding a network listener.
  { "rex.client.remoteControl", "bool", "true" },
  { "terminalFontName", "string", "Jetendard" },
  { "terminalFontStyle", "string", "Light" },
  { "terminalFontPointSize", "float", "11.5" },
  { "terminalFallbackFontNames", "array", "Hack Nerd Font" },
  { "terminalOptionKeyBehavior", "string", "actsAsAlt" },
  { "paneDensity", "string", "compact" },
  { "tabStyle", "string", "vertical" },
  { "sidebarPosition", "string", "left" },
  { "showsPaneHeaders", "bool", "false" },
  { "hiddenPaneButtons", "array", "splitRight", "splitDown", "float", "zoom", "close" },
  { "hiddenChromeButtons", "array", "newTab", "commandPalette", "activity" },
}

rex.action {
  name = "apply_preferences",
  title = "Apply Dotfiles Appearance",
  description = "Apply fonts, compact left-sidebar layout and Macchiato. Relaunch only the app if needed.",
  run = function()
    for _, pref in ipairs(preferences) do
      local key = pref[1]:find("%.") and pref[1] or "Workspace." .. pref[1]
      local command = { "/usr/bin/defaults", "write", "com.superlogical.rex", key, "-" .. pref[2] }
      for i = 3, #pref do command[#command + 1] = pref[i] end
      local result, err = rex.exec(command, { timeout = 5 })
      assert(result and result.ok, err or (result and result.stderr))
    end
    rex.client.queue("client.theme.import", {
      path = os.getenv("HOME") .. "/.config/rex/themes/Catppuccin Macchiato",
    })
    return "Preferences saved. Keep the left sidebar visible to hide pane headers; relaunch the app if needed."
  end,
}
