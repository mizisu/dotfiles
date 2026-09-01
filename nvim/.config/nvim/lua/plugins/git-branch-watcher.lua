local git_utils = require("utils.git")

local setting_base = false

local function fail(message)
  setting_base = false
  vim.notify(message, vim.log.levels.ERROR, { title = "Gitsigns" })
end

local function apply_base(base)
  require("gitsigns").change_base(base.oid, true, function(change_err)
    vim.schedule(function()
      setting_base = false
      if change_err then
        vim.notify(change_err, vim.log.levels.ERROR, { title = "Gitsigns" })
        return
      end
      vim.notify(
        string.format("Set base ref: %s (%s)", base.name, base.oid:sub(1, 7)),
        vim.log.levels.INFO,
        { title = "Gitsigns" }
      )
    end)
  end)
end

local function set_base_ref()
  if setting_base then
    vim.notify("Setting the Gitsigns base is already in progress", vim.log.levels.WARN, { title = "Gitsigns" })
    return
  end
  setting_base = true

  local repo_root, repo_err = git_utils.get_repo_root()
  if not repo_root then
    fail(repo_err)
    return
  end

  git_utils.get_pr_base(repo_root, function(base, err)
    if not base then
      fail(err)
      return
    end

    if git_utils.has_commit(repo_root, base.oid) then
      apply_base(base)
      return
    end

    vim.notify(string.format("Fetching PR base: %s", base.name), vim.log.levels.INFO, { title = "Gitsigns" })
    git_utils.fetch_pr_base(repo_root, base, function(fetch_err)
      if fetch_err then
        fail(fetch_err)
        return
      end
      apply_base(base)
    end)
  end)
end

vim.keymap.set("n", "<leader>ghg", set_base_ref, { desc = "Set base ref for gitsigns" })

return {}
