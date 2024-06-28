return {
  "nvim-neo-tree/neo-tree.nvim",
  opts = {
    filesystem = {
      filtered_items = {
        visible = true,
        show_hidden_count = false,
        hide_gitignored = false,
        hide_by_name = {},
        never_show = {
          ".git",
          ".mypy_cache",
          ".ruff_cache",
          "__pycache__",
          ".idea",
          ".DS_Store",
        },
      },
    },
    window = {
      mappings = {
        ["P"] = function(state)
          local node = state.tree:get_node()
          require("neo-tree.ui.renderer").focus_node(state, node:get_parent_id())
        end,
      },
    },
  },
}
