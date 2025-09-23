local uv = vim.loop
local git_utils = require("utils.git")

local base_ref = nil

local function change_gitsigns_base()
  if not git_utils.is_git_repo() then
    return
  end

  if base_ref then
    require("gitsigns")
    vim.cmd("Gitsigns change_base " .. base_ref)
  end
end

local function set_base_ref()
  if not git_utils.is_git_repo() then
    return
  end
  base_ref = git_utils.get_base_ref()
  print("Set base ref: " .. (base_ref or "none"))
end

vim.keymap.set("n", "<leader>ghg", function()
  set_base_ref()
  uv.new_timer():start(0, 1000, vim.schedule_wrap(change_gitsigns_base))
end, { desc = "Set base ref for gitsigns" })

return {}
