local snacks = require("snacks")

return {
    "snacks.nvim",
    opts = {
        picker = {
          hidden = true,
        },
    },

    keys = {{"<leader>/", false}, { "<leader><leader>", function()
      snacks.picker.files({
        hidden = true,
      })
    end}}
}
