-- return {
--     "linux-cultist/venv-selector.nvim",
--     dependencies = {
--         "neovim/nvim-lspconfig",
--         "nvim-telescope/telescope.nvim",
--     },
--     lazy = false,
--     branch = "regexp", -- regexp 브랜치 사용
--     config = function()
--         require("venv-selector").setup()
--     end,
--     keys = {{"<leader>cv", "<cmd>VenvSelect<cr>"}}
-- }
return {
  "linux-cultist/venv-selector.nvim",
  dependencies = {
    "neovim/nvim-lspconfig",
    "mfussenegger/nvim-dap",
    "mfussenegger/nvim-dap-python", --optional
    { "nvim-telescope/telescope.nvim", branch = "0.1.x", dependencies = { "nvim-lua/plenary.nvim" } },
  },
  lazy = false,
  branch = "regexp", -- This is the regexp branch, use this for the new version
  keys = {
    { "<leader>cv", "<cmd>VenvSelect<cr>" },
  },
  ---@type venv-selector.Config
  opts = {
    -- Your settings go here
  },
}
