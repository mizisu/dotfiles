local terminal = "com.superlogical.terminal"
local function shell(command, cwd)
  return rex.layout.block {
    flavor = terminal .. ".shell",
    options = { command = command, cwd = cwd, exit = { on_completion = false } },
  }
end

rex.action {
  name = "dev_session",
  title = "Start Project Dev Session",
  description = "Django on localhost:7777 and app/pnpm start in equal panes.",
  args = { cwd = "string?" },
  run = function(ctx, args)
    local cwd = args.cwd
    if not cwd then
      local process = assert(rex.block.call(terminal, "process", { block_id = ctx.block_id }))
      cwd = process.foreground and process.foreground.cwd or (process.child and process.child.cwd)
    end
    assert(cwd and cwd ~= "", "No working directory available")
    local git = assert(rex.exec({ "git", "-C", cwd, "rev-parse", "--show-toplevel" }, { timeout = 5 }))
    local root = git.ok and git.stdout:gsub("[\r\n]+$", "") or cwd
    for _, path in ipairs({ "manage.py", "app/package.json" }) do
      local file = assert(io.open(root .. "/" .. path, "r"), "This project has no " .. path)
      file:close()
    end
    local base = (root:match("([^/]+)/*$") or "dev"):gsub("[^%w_-]", "-"):sub(1, 110)
    local used = {}
    for _, session in ipairs(assert(rex.call("session.list", {})).sessions or {}) do used[session.label] = true end
    local name, suffix = base, 2
    while used[name] do name, suffix = base .. "-" .. suffix, suffix + 1 end
    local created = assert(rex.call("session.create", {
      label = name,
      initial_windows = { {
        window_label = "dev",
        layout = rex.layout.horizontal(0.5,
          shell({ "uv", "run", "manage.py", "runserver", "127.0.0.1:7777", "--settings=server.settings.local", "--skip-checks" }, root),
          shell({ "pnpm", "start" }, root .. "/app")),
      } },
    }))
    rex.client.queue("session.select", { session_id = created.session_id })
    return created
  end,
}

rex.action {
  name = "open_nvim",
  title = "Open File in Neovim",
  args = { path = "string", line = "integer?", column = "integer?" },
  run = function(ctx, args)
    assert(args.path:sub(1, 1) == "/" and not args.path:find("[%z\1-\31\127]"), "Expected an absolute file path without control characters")
    local line, column = args.line or 1, args.column or 1
    assert(line > 0 and column > 0, "Line and column must be positive")
    local window = assert(rex.session.view { session_id = ctx.session_id }).active_window_id
    local candidates = {}
    for _, block in ipairs(assert(rex.session.list_blocks { session_id = ctx.session_id }).blocks or {}) do
      if window and block.window_id == window then
        local socket = os.getenv("HOME") .. "/.cache/nvim/rex-" .. block.block_id:gsub("^block:", "") .. ".pipe"
        local probe = rex.exec({ "/opt/homebrew/bin/nvim", "--server", socket, "--remote-expr", "1" }, { timeout = 1 })
        if probe and probe.ok then
          local candidate = { block = block.block_id, socket = socket }
          if block.block_id == ctx.block_id then candidates = { candidate }; break end
          candidates[#candidates + 1] = candidate
        end
      end
    end
    -- shortcut: multiple editors open a new tab; add a picker if targeted reuse is needed.
    if #candidates == 1 then
      local target = candidates[1]
      local path = args.path:gsub("'", "''")
      local expression = string.format("[execute('edit ' . fnameescape('%s')), cursor(%d, %d)][-1]", path, line, column)
      local result = assert(rex.exec({ "/opt/homebrew/bin/nvim", "--server", target.socket, "--remote-expr", expression }, { timeout = 3 }))
      assert(result.ok, result.stderr)
      return assert(rex.session.focus_block { session_id = ctx.session_id, block_id = target.block })
    end
    return assert(rex.session.new_window {
      session_id = ctx.session_id,
      window_label = "Neovim",
      layout = shell({ "nvim", string.format("+call cursor(%d,%d)", line, column), "--", args.path }, args.path:match("^(.+)/") or "/"),
    })
  end,
}
