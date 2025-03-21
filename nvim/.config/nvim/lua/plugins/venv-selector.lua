return {
    "linux-cultist/venv-selector.nvim",
    dependencies = {
        "neovim/nvim-lspconfig",
        "nvim-telescope/telescope.nvim",
    },
    lazy = false,
    branch = "regexp", -- regexp 브랜치 사용
    config = function()
        require("venv-selector").setup()
    end,
    keys = {{"<leader>cv", "<cmd>VenvSelect<cr>"}}
}
