return {
  "dmtrKovalenko/fff.nvim",
  build = "cargo build --release",
  -- or if you are using nixos
  -- build = "nix run .#release",
  opts = {
    layout = {
      prompt_position = "top",
      ignore_file = { ".ignore", ".gitignore" }, -- accepts string or list table
    },
    -- pass here all the options
  },
  keys = {
    {
      "<leader><leader>", -- try it if you didn't it is a banger keybinding for a picker
      function()
        require("fff").find_files() -- or find_in_git_root() if you only want git files
      end,
      desc = "Open file picker",
    },
  },
}
