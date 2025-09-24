local M = {}

M.input_sources = {
	english = "com.apple.keylayout.ABC",
	korean = "com.apple.inputmethod.Korean.2SetKorean",
}

-- eventtap 객체를 모듈 레벨에 저장하여 가비지 컬렉션 방지
M.eventtap = nil

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

local function setup_eventtap()
	if M.eventtap then
		M.eventtap:stop()
	end

	M.eventtap = hs.eventtap.new({
		hs.eventtap.event.types.flagsChanged,
		hs.eventtap.event.types.keyDown,
	}, function(event)
		local flags = event:getFlags()
		local keycode = hs.keycodes.map[event:getKeyCode()]

		-- rightcmd, rightctrl로 한영 전환
		if (keycode == "rightcmd" and flags.cmd) or (keycode == "rightctrl" and flags.ctrl) then
			change_input_source()
			return nil
		end

		-- ctrl+c: 영어로 전환 후 원래 동작 유지
		if keycode == "c" and flags.ctrl and not flags.cmd and not flags.alt and not flags.shift then
			convert_to_english()
			return nil
		end

		-- ctrl+h: 영어로 전환 후 원래 동작 유지
		if keycode == "h" and flags.ctrl and not flags.cmd and not flags.alt and not flags.shift then
			convert_to_english()
			return nil
		end

		-- alt+1: 영어로 전환 후 원래 동작 유지
		if keycode == "1" and flags.alt and not flags.cmd and not flags.ctrl and not flags.shift then
			convert_to_english()
			return nil
		end

		return nil
	end)

	M.eventtap:start()
end

function M.setup()
	setup_eventtap()
end

function M.stop()
	if M.eventtap then
		M.eventtap:stop()
		M.eventtap = nil
	end
end

return M
