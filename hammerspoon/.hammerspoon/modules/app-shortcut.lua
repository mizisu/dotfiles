local M = {}

function M.setup()
	hs.hotkey.bind({ "cmd", "shift" }, "1", function()
		hs.application.open("Ghostty")
	end)

	hs.hotkey.bind({ "cmd", "shift" }, "2", function()
		hs.application.open("Google Chrome")
	end)

	hs.hotkey.bind({ "cmd", "shift" }, "3", function()
		hs.application.open("Slack")
	end)
end

return M
