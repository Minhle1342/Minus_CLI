"""
Native Windows / Cross-platform Desktop Driver for Computer Use Agent.
Provides low-level desktop control: screenshot, mouse move/click/drag, scroll, keyboard type/key.
"""
import sys
import os
import json
import time
import base64
import ctypes
from ctypes import wintypes

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

WINSTA_ALL = 0x37F
DESKTOP_ALL = 0x1FF

def attach_desktop():
    try:
        hwinsta = user32.OpenWindowStationW("WinSta0", False, WINSTA_ALL)
        if hwinsta:
            user32.SetProcessWindowStation(hwinsta)
        hdesk = user32.OpenDesktopW("default", 0, False, DESKTOP_ALL)
        if hdesk:
            user32.SetThreadDesktop(hdesk)
    except Exception:
        pass

attach_desktop()

class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

def get_screen_size():
    w = user32.GetSystemMetrics(0)
    h = user32.GetSystemMetrics(1)
    return w, h

def get_cursor_pos():
    pt = POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return pt.x, pt.y

def set_cursor_pos(x, y):
    sw, sh = get_screen_size()
    clamped_x = max(0, min(sw - 1, int(x)))
    clamped_y = max(0, min(sh - 1, int(y)))
    user32.SetCursorPos(clamped_x, clamped_y)
    return clamped_x, clamped_y

# Mouse events
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_ABSOLUTE = 0x8000

def mouse_click(button="left", clicks=1):
    down_flag = MOUSEEVENTF_LEFTDOWN
    up_flag = MOUSEEVENTF_LEFTUP
    if button == "right":
        down_flag = MOUSEEVENTF_RIGHTDOWN
        up_flag = MOUSEEVENTF_RIGHTUP
    elif button == "middle":
        down_flag = MOUSEEVENTF_MIDDLEDOWN
        up_flag = MOUSEEVENTF_MIDDLEUP

    for i in range(clicks):
        user32.mouse_event(down_flag, 0, 0, 0, 0)
        time.sleep(0.03)
        user32.mouse_event(up_flag, 0, 0, 0, 0)
        if i < clicks - 1:
            time.sleep(0.1)

def mouse_down(button="left"):
    flag = MOUSEEVENTF_LEFTDOWN
    if button == "right":
        flag = MOUSEEVENTF_RIGHTDOWN
    elif button == "middle":
        flag = MOUSEEVENTF_MIDDLEDOWN
    user32.mouse_event(flag, 0, 0, 0, 0)

def mouse_up(button="left"):
    flag = MOUSEEVENTF_LEFTUP
    if button == "right":
        flag = MOUSEEVENTF_RIGHTUP
    elif button == "middle":
        flag = MOUSEEVENTF_MIDDLEUP
    user32.mouse_event(flag, 0, 0, 0, 0)

def mouse_drag(start_x, start_y, end_x, end_y, duration_ms=250):
    set_cursor_pos(start_x, start_y)
    time.sleep(0.05)
    mouse_down("left")
    time.sleep(0.05)
    steps = max(5, int(duration_ms / 20))
    for i in range(1, steps + 1):
        cur_x = int(start_x + (end_x - start_x) * (i / steps))
        cur_y = int(start_y + (end_y - start_y) * (i / steps))
        set_cursor_pos(cur_x, cur_y)
        time.sleep(0.02)
    mouse_up("left")

def mouse_scroll(direction="down", amount=3):
    ticks = int(amount) * 120
    if direction in ("down", "left"):
        ticks = -ticks
    user32.mouse_event(MOUSEEVENTF_WHEEL, 0, 0, ticks, 0)

# Keyboard events via SendInput
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_EXTENDEDKEY = 0x0001

class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_ulonglong)
    ]

class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_ulonglong)
    ]

class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD)
    ]

class _INPUT_UNION(ctypes.Union):
    _fields_ = [
        ("ki", KEYBDINPUT),
        ("mi", MOUSEINPUT),
        ("hi", HARDWAREINPUT)
    ]

class INPUT(ctypes.Structure):
    _fields_ = [
        ("type", wintypes.DWORD),
        ("union", _INPUT_UNION)
    ]

def type_text(text, interval_ms=15):
    for char in text:
        inp1 = INPUT()
        inp1.type = INPUT_KEYBOARD
        inp1.union.ki.wVk = 0
        inp1.union.ki.wScan = ord(char)
        inp1.union.ki.dwFlags = KEYEVENTF_UNICODE
        
        inp2 = INPUT()
        inp2.type = INPUT_KEYBOARD
        inp2.union.ki.wVk = 0
        inp2.union.ki.wScan = ord(char)
        inp2.union.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
        
        inputs = (INPUT * 2)(inp1, inp2)
        user32.SendInput(2, inputs, ctypes.sizeof(INPUT))
        if interval_ms > 0:
            time.sleep(interval_ms / 1000.0)

VK_MAP = {
    'enter': 0x0D, 'return': 0x0D, 'tab': 0x09, 'space': 0x20,
    'backspace': 0x08, 'escape': 0x1B, 'esc': 0x1B, 'delete': 0x2E,
    'del': 0x2E, 'up': 0x26, 'down': 0x28, 'left': 0x25, 'right': 0x27,
    'home': 0x24, 'end': 0x23, 'pageup': 0x21, 'pagedown': 0x22,
    'ctrl': 0x11, 'control': 0x11, 'shift': 0x10, 'alt': 0x12,
    'win': 0x5B, 'windows': 0x5B, 'insert': 0x2D,
}
for i in range(1, 13):
    VK_MAP[f'f{i}'] = 0x6F + i
for c in 'abcdefghijklmnopqrstuvwxyz0123456789':
    VK_MAP[c] = ord(c.upper())

def press_key(key_combo):
    parts = [p.strip().lower() for p in key_combo.split('+')]
    vks = []
    for p in parts:
        if p in VK_MAP:
            vks.append(VK_MAP[p])
        elif len(p) == 1:
            vks.append(ord(p.upper()))
        else:
            return False, f"Unknown key in combination: '{p}'"

    for vk in vks:
        user32.keybd_event(vk, 0, 0, 0)
    time.sleep(0.05)
    for vk in reversed(vks):
        user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
    return True, f"Pressed {key_combo}"

def capture_screenshot(out_path=None, max_width=1280, max_height=800, return_base64=True):
    from PIL import Image
    width, height = get_screen_size()
    hdc_screen = user32.GetDC(0)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
    hbitmap = gdi32.CreateCompatibleBitmap(hdc_screen, width, height)
    h_old = gdi32.SelectObject(hdc_mem, hbitmap)
    
    SRCCOPY = 0x00CC0020
    gdi32.BitBlt(hdc_mem, 0, 0, width, height, hdc_screen, 0, 0, SRCCOPY)
    
    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", wintypes.DWORD),
            ("biWidth", wintypes.LONG),
            ("biHeight", wintypes.LONG),
            ("biPlanes", wintypes.WORD),
            ("biBitCount", wintypes.WORD),
            ("biCompression", wintypes.DWORD),
            ("biSizeImage", wintypes.DWORD),
            ("biXPelsPerMeter", wintypes.LONG),
            ("biYPelsPerMeter", wintypes.LONG),
            ("biClrUsed", wintypes.DWORD),
            ("biClrImportant", wintypes.DWORD),
        ]

    bmi = BITMAPINFOHEADER()
    bmi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.biWidth = width
    bmi.biHeight = -height
    bmi.biPlanes = 1
    bmi.biBitCount = 32
    bmi.biCompression = 0

    buf = ctypes.create_string_buffer(width * height * 4)
    gdi32.GetDIBits(hdc_mem, hbitmap, 0, height, buf, ctypes.byref(bmi), 0)
    
    user32.ReleaseDC(0, hdc_screen)
    gdi32.DeleteDC(hdc_mem)
    gdi32.DeleteObject(hbitmap)
    
    img = Image.frombuffer("RGBA", (width, height), buf, "raw", "BGRA", 0, 1)
    img = img.convert("RGB")
    
    orig_w, orig_h = img.size
    if max_width and max_height:
        img.thumbnail((max_width, max_height), Image.Resampling.LANCZOS)
    
    scaled_w, scaled_h = img.size
    
    if out_path:
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        img.save(out_path, format="PNG")
    
    b64_str = None
    if return_base64:
        import io
        byte_arr = io.BytesIO()
        img.save(byte_arr, format="PNG")
        b64_str = base64.b64encode(byte_arr.getvalue()).decode("utf-8")
        
    return {
        "original_width": orig_w,
        "original_height": orig_h,
        "width": scaled_w,
        "height": scaled_h,
        "scale_x": orig_w / scaled_w if scaled_w else 1.0,
        "scale_y": orig_h / scaled_h if scaled_h else 1.0,
        "path": out_path,
        "base64": b64_str,
    }

def main():
    raw_input = ""
    if len(sys.argv) > 1:
        arg = sys.argv[1].strip()
        if arg.startswith("b64:"):
            try:
                raw_input = base64.b64decode(arg[4:]).decode("utf-8")
            except Exception:
                raw_input = arg
        else:
            raw_input = arg
    else:
        raw_input = sys.stdin.read().strip()

    if not raw_input:
        print(json.dumps({"success": False, "error": "No input payload provided"}))
        return

    try:
        data = json.loads(raw_input)
    except Exception:
        # Fallback: attempt base64 decoding of the whole raw_input
        try:
            decoded = base64.b64decode(raw_input).decode("utf-8")
            data = json.loads(decoded)
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Invalid JSON payload: {str(e)}"}))
            return

    action = data.get("action", "screenshot")

    # Unpack coordinate array [x, y] if provided (Anthropic format)
    if "coordinate" in data and isinstance(data["coordinate"], (list, tuple)) and len(data["coordinate"]) == 2:
        data["x"] = data["coordinate"][0]
        data["y"] = data["coordinate"][1]
    if "start_coordinate" in data and isinstance(data["start_coordinate"], (list, tuple)) and len(data["start_coordinate"]) == 2:
        data["start_x"] = data["start_coordinate"][0]
        data["start_y"] = data["start_coordinate"][1]
    if "end_coordinate" in data and isinstance(data["end_coordinate"], (list, tuple)) and len(data["end_coordinate"]) == 2:
        data["end_x"] = data["end_coordinate"][0]
        data["end_y"] = data["end_coordinate"][1]

    # Normalize action aliases
    if action == "left_click":
        action = "click"
        data["button"] = "left"
        data["clicks"] = 1
    elif action == "right_click":
        action = "click"
        data["button"] = "right"
        data["clicks"] = 1
    elif action == "double_click":
        action = "click"
        data["button"] = "left"
        data["clicks"] = 2
    elif action == "triple_click":
        action = "click"
        data["button"] = "left"
        data["clicks"] = 3
    elif action == "middle_click":
        action = "click"
        data["button"] = "middle"
        data["clicks"] = 1
    elif action in ("left_click_drag", "mouse_drag"):
        action = "drag"
    elif action == "move":
        action = "mouse_move"
    elif action in ("hotkey", "press"):
        action = "key"

    try:
        if action == "screen_size":
            w, h = get_screen_size()
            print(json.dumps({"success": True, "action": "screen_size", "width": w, "height": h}))

        elif action == "cursor_position":
            x, y = get_cursor_pos()
            print(json.dumps({"success": True, "action": "cursor_position", "x": x, "y": y}))

        elif action == "mouse_move":
            x = data.get("x", 0)
            y = data.get("y", 0)
            fx, fy = set_cursor_pos(x, y)
            print(json.dumps({"success": True, "action": "mouse_move", "x": fx, "y": fy}))

        elif action == "click":
            x = data.get("x")
            y = data.get("y")
            button = data.get("button", "left")
            clicks = int(data.get("clicks", 1))
            if x is not None and y is not None:
                set_cursor_pos(x, y)
                time.sleep(0.02)
            mouse_click(button=button, clicks=clicks)
            cx, cy = get_cursor_pos()
            print(json.dumps({"success": True, "action": "click", "button": button, "clicks": clicks, "x": cx, "y": cy}))

        elif action == "mouse_down":
            button = data.get("button", "left")
            mouse_down(button)
            cx, cy = get_cursor_pos()
            print(json.dumps({"success": True, "action": "mouse_down", "button": button, "x": cx, "y": cy}))

        elif action == "mouse_up":
            button = data.get("button", "left")
            mouse_up(button)
            cx, cy = get_cursor_pos()
            print(json.dumps({"success": True, "action": "mouse_up", "button": button, "x": cx, "y": cy}))

        elif action == "drag":
            start_x = int(data.get("start_x", 0))
            start_y = int(data.get("start_y", 0))
            end_x = int(data.get("end_x", 0))
            end_y = int(data.get("end_y", 0))
            duration = int(data.get("duration_ms", 250))
            mouse_drag(start_x, start_y, end_x, end_y, duration)
            print(json.dumps({"success": True, "action": "drag", "end_x": end_x, "end_y": end_y}))

        elif action == "scroll":
            direction = data.get("direction", "down")
            amount = int(data.get("amount", 3))
            mouse_scroll(direction, amount)
            print(json.dumps({"success": True, "action": "scroll", "direction": direction, "amount": amount}))

        elif action == "type":
            text = data.get("text", "")
            interval = int(data.get("interval_ms", 15))
            type_text(text, interval)
            print(json.dumps({"success": True, "action": "type", "textLength": len(text)}))

        elif action == "key":
            key_combo = data.get("key", "")
            ok, msg = press_key(key_combo)
            print(json.dumps({"success": ok, "action": "key", "key": key_combo, "message": msg}))

        elif action == "wait":
            duration_ms = int(data.get("duration_ms", 500))
            time.sleep(duration_ms / 1000.0)
            print(json.dumps({"success": True, "action": "wait", "duration_ms": duration_ms}))

        elif action == "screenshot":
            out_path = data.get("out_path")
            max_w = int(data.get("max_width", 1280))
            max_h = int(data.get("max_height", 800))
            ret_b64 = bool(data.get("return_base64", False))
            res = capture_screenshot(out_path, max_w, max_h, ret_b64)
            res["success"] = True
            res["action"] = "screenshot"
            print(json.dumps(res))

        else:
            print(json.dumps({"success": False, "error": f"Unknown action: '{action}'"}))

    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == "__main__":
    main()