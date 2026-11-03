require("preferences")
require("workflows")

-- Match tmux: Alt+1..9 selects the corresponding tab in either input source.
for index = 1, 9 do
  rex.bind("alt+[Digit" .. index .. "]", "client.tab.goto", { index = index })
end

local function navigate(ctx, direction)
  -- Rex's native right wrap can land on the middle of three equal panes.
  local result, err = rex.session.focus_direction {
    session_id = ctx.session_id, direction = direction, wrap = direction == "left",
  }
  if not result or direction ~= "right" then return result, err end

  local view
  view, err = rex.session.view { session_id = ctx.session_id }
  if not view then return nil, err end
  for _, window in ipairs(view.windows or {}) do
    if window.window_id == view.active_window_id and window.focused_block_id == ctx.block_id then
      -- No pane to the right: restart at the first pane in layout order.
      for _, layer in ipairs(window.layers or {}) do
        local first = (layer.blocks or {})[1]
        if first then
          return rex.session.focus_block { session_id = ctx.session_id, block_id = first.block_id }
        end
      end
    end
  end
  return result
end

-- Neovim uses this same action after reaching the edge of its own splits.
rex.action {
  name = "navigate",
  title = "Navigate Pane",
  args = { direction = "string" },
  run = function(ctx, args) return assert(navigate(ctx, args.direction)) end,
}

-- Physical keys keep navigation consistent with Korean and English input sources.
-- Neovim handles its own splits first; rit keeps its horizontal review shortcuts.
for key, direction in pairs({ H = "left", J = "down", K = "up", L = "right" }) do
  rex.bind("ctrl+[Key" .. key .. "]", function(ctx)
    local process = rex.block.call("com.superlogical.terminal", "process", { block_id = ctx.block_id })
    local foreground = process and process.foreground or {}
    local name = (foreground.script or foreground.argv0 or foreground.name or ""):match("([^/]+)$")
    if name == "nvim" or name == "vim" or name == "tmux" then return false end
    if name == "rit" and key == "L" then return false end
    if name == "rit" and key == "H" then
      -- Like rit's tmux integration, distinguish Ctrl+H from Backspace.
      assert(rex.block.call("com.superlogical.terminal", "write", {
        block_id = ctx.block_id, data = "\27[104;5u",
      }))
      return true
    end
    local result, err = navigate(ctx, direction)
    if not result then rex.log("warn", err) end
    return true
  end)
end

-- Shift moves the pane itself; plain Ctrl+H/L only changes focus.
for key, direction in pairs({ H = "left", L = "right" }) do
  rex.bind("ctrl+shift+[Key" .. key .. "]", "pane.move", { direction = direction })
end

-- Match Kitty: send End, not Ctrl+E (Pi binds Ctrl+E to opening Neovim).
rex.bind("cmd+right", "pane.send_key", { key = "end" })

-- Hide only our persistent terminal popup. Elsewhere Pi owns Ctrl+/.
rex.bind("ctrl+[Slash]", function(ctx)
  local list = rex.session.list_blocks { session_id = ctx.session_id }
  for _, block in ipairs(list and list.blocks or {}) do
    if block.block_id == ctx.block_id then
      local parent = (block.label or ""):match("^pi%-popup:(block:[^:]+):terminal$")
      if not parent then return false end
      assert(rex.session.detach_block { session_id = ctx.session_id, block_id = ctx.block_id })
      assert(rex.session.focus_block { session_id = ctx.session_id, block_id = parent })
      return true
    end
  end
  return false
end)
