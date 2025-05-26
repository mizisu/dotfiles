local snacks = require("snacks")

return {
  "snacks.nvim",
  opts = {
    picker = {
      hidden = true,
      win = {
        input = {
          keys = {
            ["<a-r>"] = { "toggle_regex", mode = { "i", "n" } },
          },
        },
      },
    },
  },

  keys = {
    { "<leader>.", false, desc = "Toggle Scratch Buffer" },
    { "<leader>S", false, desc = "Select Scratch Buffer" },

    { "<leader>/", false },
    {
      "<leader><leader>",
      function()
        snacks.picker.smart({
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
    {
      "<leader>ba",
      function()
        snacks.bufdelete.all()
      end,
      desc = "Delete all buffers",
    },
  },
}
