return {
  "pwntester/octo.nvim",
  dependencies = {
    "nvim-lua/plenary.nvim",
    "nvim-telescope/telescope.nvim",
    "nvim-tree/nvim-web-devicons",
  },
  cmd = "Octo",
  keys = {
    { "<leader>go", "<cmd>Octo<cr>", desc = "Octo" },
    { "<leader>goi", "<cmd>Octo issue list<cr>", desc = "Issue List" },
    { "<leader>gop", "<cmd>Octo pr list<cr>", desc = "PR List" },
    { "<leader>gor", "<cmd>Octo review start<cr>", desc = "Start Review" },
  },
  opts = {},
}