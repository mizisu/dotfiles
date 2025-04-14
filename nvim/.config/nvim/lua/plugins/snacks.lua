local snacks = require("snacks")

return {
  "snacks.nvim",
  opts = {
    picker = {
      hidden = true,
    },
  },

  keys = {
    { "<leader>/", false },
    {
      "<leader><leader>",
      function()
        snacks.picker.files({
          hidden = true,
          -- ignored = true,
        })
      end,
      desc = "Find Files",
    },
    {
      "<leader>sg",
      function()
        snacks.picker.grep({
          hidden = true,
          regex = false,
        })
      end,
      desc = "Grep",
    },
  },
}
