return {
  {
    "rcarriga/nvim-dap-ui",
    enabled = false,
  },
  {
    "theHamsta/nvim-dap-virtual-text",
    enabled = false,
  },
  {
    "igorlfs/nvim-dap-view",
    lazy = false,
    version = "1.*",
    main = "dap-view",
    dependencies = { "mfussenegger/nvim-dap" },
    opts = {
      auto_toggle = "keep_terminal",
      winbar = {
        sections = { "watches", "scopes", "breakpoints", "threads", "repl", "exceptions" },
        default_section = "watches",
      },
      virtual_text = {
        enabled = true,
      },
    },
    keys = {
      {
        "<leader>du",
        function()
          require("dap-view").toggle(true)
        end,
        desc = "Toggle DAP view",
      },
      {
        "<leader>dw",
        desc = "DAP views",
      },
      {
        "<leader>dwb",
        function()
          require("dap-view").jump_to_view("breakpoints")
        end,
        desc = "Jump to breakpoints",
      },
      {
        "<leader>dwo",
        function()
          require("dap-view").jump_to_view("scopes")
        end,
        desc = "Jump to scopes",
      },
      {
        "<leader>dwr",
        function()
          require("dap-view").jump_to_view("repl")
        end,
        desc = "Jump to REPL",
      },
      {
        "<leader>dws",
        function()
          require("dap-view").jump_to_view("threads")
        end,
        desc = "Jump to threads",
      },
      {
        "<leader>dww",
        function()
          require("dap-view").jump_to_view("watches")
        end,
        desc = "Jump to watches",
      },
    },
  },
}
