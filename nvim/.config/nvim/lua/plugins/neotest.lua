return {
  "nvim-neotest/neotest",
  optional = true,
  dependencies = {
    "nvim-neotest/neotest-python",
  },
  opts = {
    adapters = {
      ["neotest-python"] = {
        args = { "--settings=server.settings.test", "--keepdb" },
      },
    },
  },
}
