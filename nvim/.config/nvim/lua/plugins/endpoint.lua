return {
  "zerochae/endpoint.nvim",
  dependencies = {
    -- Choose one or more pickers (all optional):
    "nvim-telescope/telescope.nvim", -- For telescope picker
    "folke/snacks.nvim", -- For snacks picker
    -- vim.ui.select picker works without dependencies
  },
  cmd = { "Endpoint", "EndpointRefresh" },
  config = function()
    require("endpoint").setup({
      picker = { type = "snacks" },
    })
  end,
}
