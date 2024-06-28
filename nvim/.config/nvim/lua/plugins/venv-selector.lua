return {
  "linux-cultist/venv-selector.nvim",
  branch = "regexp", -- Use this branch for the new version
  cmd = "VenvSelect",
  opts = {
    settings = {
      search = {
        pipenv = {
          command = "fd -p 'bin/python$' ~/.local/share/virtualenvs/",
        },
      },
      options = {
        notify_user_on_venv_activation = true,
      },
    },
  },
  --  Call config for python files and load the cached venv automatically
  ft = "python",
  keys = { { "<leader>cv", "<cmd>:VenvSelect<cr>", desc = "Select VirtualEnv", ft = "python" } },
}
