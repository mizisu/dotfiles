local M = {}

local ENGLISH = "com.apple.keylayout.ABC"
local KOREAN = "com.apple.inputmethod.Korean.2SetKorean"

M.input_sources = { english = ENGLISH, korean = KOREAN }

-- 자주 호출되는 함수를 로컬에 캐싱 (글로벌 테이블 룩업 제거)
local currentSourceID = hs.keycodes.currentSourceID

-- 키코드 숫자 상수 (문자열 변환/비교 제거, 정수 비교만 수행)
local KC_RIGHTCMD = hs.keycodes.map["rightcmd"]
local KC_RIGHTCTRL = hs.keycodes.map["rightctrl"]
local KC_C = hs.keycodes.map["c"]
local KC_H = hs.keycodes.map["h"]
local KC_1 = hs.keycodes.map["1"]

-- eventtap 객체를 모듈 레벨에 저장하여 가비지 컬렉션 방지
M._flags_tap = nil
M._key_tap = nil

-- 입력 소스 상태 캐싱 (매번 시스템 API 호출 대신 변수 비교)
local cached_source = nil

local function change_input_source()
	if cached_source == ENGLISH then
		currentSourceID(KOREAN)
	else
		currentSourceID(ENGLISH)
	end
end

local function convert_to_english()
	if cached_source ~= ENGLISH then
		currentSourceID(ENGLISH)
	end
end

local function setup_eventtap()
	if M._flags_tap then M._flags_tap:stop() end
	if M._key_tap then M._key_tap:stop() end

	-- 초기 상태 동기화
	cached_source = currentSourceID()

	-- 입력 소스 변경 시 캐시 자동 동기화 (메뉴바 등 외부 전환 포함)
	hs.keycodes.inputSourceChanged(function()
		cached_source = currentSourceID()
	end)

	-- modifier 전용: rightcmd/rightctrl 한영 전환
	M._flags_tap = hs.eventtap.new({ hs.eventtap.event.types.flagsChanged }, function(event)
		local kc = event:getKeyCode()
		if kc == KC_RIGHTCMD then
			if event:getFlags().cmd then
				change_input_source()
			end
		elseif kc == KC_RIGHTCTRL then
			if event:getFlags().ctrl then
				change_input_source()
			end
		end
		return nil
	end)

	-- keyDown 전용: ctrl+c, ctrl+h, alt+1 영어 전환
	M._key_tap = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function(event)
		local kc = event:getKeyCode()

		-- 관심 없는 키는 즉시 반환 (getFlags 호출 자체를 생략)
		if kc ~= KC_C and kc ~= KC_H and kc ~= KC_1 then
			return nil
		end

		local flags = event:getFlags()

		if (kc == KC_C or kc == KC_H) and flags.ctrl and not flags.cmd and not flags.alt and not flags.shift then
			convert_to_english()
			return nil
		end

		if kc == KC_1 and flags.alt and not flags.cmd and not flags.ctrl and not flags.shift then
			convert_to_english()
			return nil
		end

		return nil
	end)

	M._flags_tap:start()
	M._key_tap:start()
end

function M.setup()
	setup_eventtap()
end

function M.stop()
	if M._flags_tap then
		M._flags_tap:stop()
		M._flags_tap = nil
	end
	if M._key_tap then
		M._key_tap:stop()
		M._key_tap = nil
	end
end

return M
