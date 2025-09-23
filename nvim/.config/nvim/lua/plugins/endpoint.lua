return {
  "zerochae/endpoint.nvim",
  dependencies = { "nvim-telescope/telescope.nvim" },
  cmd = { "Endpoint" },
  config = function()
    require("endpoint").setup({
      cache_mode = "persistent", -- Save cache between sessions
      ui = { use_nerd_font = true }, -- Use nerd font icons
    })
  end,
}
