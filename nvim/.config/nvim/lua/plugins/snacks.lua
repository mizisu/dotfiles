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
      sources = {
        explorer = {
          win = {
            list = {
              keys = {
                ["<c-y>"] = "explorer_yank_filename",
              },
            },
          },
        },
      },
      actions = {
        explorer_yank_filename = function(picker)
          local items = picker:selected({ fallback = true })
          if #items > 0 then
            local filenames = {}
            for _, item in ipairs(items) do
              table.insert(filenames, vim.fn.fnamemodify(item.file, ":t"))
            end
            local value = table.concat(filenames, "\n")
            vim.fn.setreg("+", value)
            snacks.notify.info("Copied " .. #filenames .. " filename(s)")
          end
        end,
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
