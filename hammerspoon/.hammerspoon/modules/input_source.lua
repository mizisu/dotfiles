local M = {}

M.input_sources = {
	english = "com.apple.keylayout.ABC",
	korean = "com.apple.inputmethod.Korean.2SetKorean",
}

local function change_input_source()
	local current = hs.keycodes.currentSourceID()
	local next_input = nil

	if current == M.input_sources.english then
		next_input = M.input_sources.korean
	else
		next_input = M.input_sources.english
	end
	hs.keycodes.currentSourceID(next_input)
end

local function convert_to_english()
	local input_source = hs.keycodes.currentSourceID()
	if not (input_source == M.input_sources.english) then
		hs.keycodes.currentSourceID(M.input_sources.english)
	end
end

local function setup_control_key_change_kor_en()
	local control_keyevent = hs.eventtap.new({
		hs.eventtap.event.types.flagsChanged,
		hs.eventtap.event.types.keyDown,
	}, function(event)
		local flags = event:getFlags()
		local keycode = hs.keycodes.map[event:getKeyCode()]

		if keycode == "rightcmd" and flags.cmd then
			change_input_source()
		end

		if keycode == "rightctrl" and flags.ctrl then
			change_input_source()
		end
	end)

	control_keyevent:start()
end

local function setup_input_source_hotkeys()
	local input_source_keyevent = hs.eventtap.new({
		hs.eventtap.event.types.keyDown,
	}, function(event)
		local flags = event:getFlags()
		local keycode = hs.keycodes.map[event:getKeyCode()]

		if (flags.ctrl and keycode == "c") or 
		   (flags.ctrl and keycode == "h") or 
		   (flags.alt and keycode == "1") then
			convert_to_english()
		end

		return false
	end)

	input_source_keyevent:start()
end

function M.setup()
	setup_control_key_change_kor_en()
	setup_input_source_hotkeys()
end

return M
