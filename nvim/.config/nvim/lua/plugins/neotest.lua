return {
  "nvim-neotest/neotest",
  optional = true,
  dependencies = {
    "nvim-neotest/neotest-python",
  },
  opts = {
    adapters = {
      ["neotest-python"] = {
        env = { DJANGO_SETTINGS_MODULE = "server.settings.test" },
        django_settings_module = "server.settings.test",
        args = { "--settings=server.settings.test", "--keepdb" },
      },
    },
  },
}
