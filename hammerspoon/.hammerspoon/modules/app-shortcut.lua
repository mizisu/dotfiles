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

	hs.hotkey.bind({ "cmd", "shift" }, "g", function()
		hs.urlevent.openURL("https://calendar.google.com/")
	end)
end

return M
