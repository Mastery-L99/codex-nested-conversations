// ==WindhawkMod==
// @id              codex-nested-conversations-autoload
// @name            Codex Nested Conversations - original icon loading
// @description     Enable the local adapter when the installed official app starts.
// @version         0.1.0
// @author          Codex Nested Conversations contributors
// @github          https://github.com/Mastery-L99
// @homepage        https://github.com/Mastery-L99/codex-nested-conversations
// @include         ChatGPT.exe
// @architecture    x86-64
// @compilerOptions -lshell32
// @license         MIT
// ==/WindhawkMod==

// Source prototype. The payload tests do not prove early loading in Codex.
// Requires Windhawk's normal early-loading engine, rather than target-only late
// injection. Does not modify official files, package registrations, or shortcuts.
#include <windows.h>
#include <appmodel.h>
#include <shellapi.h>
#include <string>
#include <iterator>

namespace cncc {
constexpr wchar_t kFamily[] = L"OpenAI.Codex_2p2nqsd0c76g0";
constexpr wchar_t kSuffix[] = L" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9347";
struct Candidate { bool augment; const wchar_t* reason; std::wstring command; };

bool IsSwitch(const std::wstring& value, const wchar_t* name) {
    const std::wstring key = std::wstring(name).substr(2);
    const size_t prefix = value.rfind(L"--", 0) == 0 ? 2 :
        (!value.empty() && (value[0] == L'-' || value[0] == L'/') ? 1 : 0);
    if (!prefix || value.size() < prefix + key.size()) return false;
    const auto body = value.substr(prefix);
    return _wcsnicmp(body.c_str(), key.c_str(), key.size()) == 0 &&
        (body.size() == key.size() || body[key.size()] == L'=');
}

bool IsOfficialImage(const std::wstring& packagePath, const std::wstring& image) {
    if (packagePath.empty()) return false;
    auto root = packagePath;
    while (!root.empty() && (root.back() == L'\\' || root.back() == L'/')) root.pop_back();
    const auto expected = root + L"\\app\\ChatGPT.exe";
    return _wcsicmp(expected.c_str(), image.c_str()) == 0;
}

Candidate BuildCandidate(const std::wstring& family, const std::wstring& image, const std::wstring& raw) {
    if (family != kFamily) return {false, L"not_official_package", {}};
    const auto slash = image.find_last_of(L"\\/");
    const auto file = image.substr(slash == std::wstring::npos ? 0 : slash + 1);
    if (_wcsicmp(file.c_str(), L"ChatGPT.exe") != 0) return {false, L"not_main_image", {}};
    if (raw.empty() || raw.size() + std::size(kSuffix) > 32767) return {false, L"command_line_length", {}};
    int count = 0;
    auto args = CommandLineToArgvW(raw.c_str(), &count);
    if (!args || count < 1) { if (args) LocalFree(args); return {false, L"command_line_parse", {}}; }
    const wchar_t* reason = nullptr;
    for (int i = 1; i < count && !reason; ++i) {
        const std::wstring arg(args[i]);
        if (IsSwitch(arg, L"--type")) reason = L"child_process";
        else if (IsSwitch(arg, L"--remote-debugging-port") || IsSwitch(arg, L"--remote-debugging-pipe") ||
                 IsSwitch(arg, L"--remote-debugging-address")) reason = L"already_configured";
        else if (arg == L"--") reason = L"switch_terminator";
        else if (IsSwitch(arg, L"--single-argument")) reason = L"single_argument_mode";
    }
    LocalFree(args);
    if (reason) return {false, reason, {}};
    return {true, L"ready", raw + kSuffix};
}
}  // namespace cncc

#ifndef CNCC_CORE_ONLY
#include <windhawk_api.h>

using GetCommandLineWType = LPWSTR(WINAPI*)();
static GetCommandLineWType originalGetCommandLineW = nullptr;
static wchar_t* augmentedCommandLine = nullptr;

static LPWSTR WINAPI GetCommandLineWHook() {
    return augmentedCommandLine ? augmentedCommandLine : originalGetCommandLineW();
}

BOOL Wh_ModInit() {
    wchar_t family[PACKAGE_FAMILY_NAME_MAX_LENGTH + 1] = {};
    UINT32 familyLength = static_cast<UINT32>(std::size(family));
    if (GetCurrentPackageFamilyName(&familyLength, family) != ERROR_SUCCESS) return FALSE;
    wchar_t image[32768] = {};
    const DWORD length = GetModuleFileNameW(nullptr, image, static_cast<DWORD>(std::size(image)));
    if (!length || length >= std::size(image)) return FALSE;
    wchar_t packagePath[32768] = {};
    UINT32 pathLength = static_cast<UINT32>(std::size(packagePath));
    if (GetCurrentPackagePath(&pathLength, packagePath) != ERROR_SUCCESS || !cncc::IsOfficialImage(packagePath, image)) return FALSE;
    const auto candidate = cncc::BuildCandidate(family, image, GetCommandLineW());
    if (!candidate.augment) { Wh_Log(L"CNCC: skipped (%s)", candidate.reason); return FALSE; }
    // Late attachment cannot retroactively reparse startup switches. Preserve the
    // running application and wait for the user's next ordinary launch instead.
    if (GetModuleHandleW(L"chrome.dll")) { Wh_Log(L"CNCC: too late; reopen the app normally when convenient"); return FALSE; }
    const SIZE_T bytes = (candidate.command.size() + 1) * sizeof(wchar_t);
    auto buffer = static_cast<wchar_t*>(VirtualAlloc(nullptr, bytes, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE));
    if (!buffer) return FALSE;
    CopyMemory(buffer, candidate.command.c_str(), bytes);
    DWORD previous = 0;
    if (!VirtualProtect(buffer, bytes, PAGE_READONLY, &previous)) { VirtualFree(buffer, 0, MEM_RELEASE); return FALSE; }
    auto kernelBase = GetModuleHandleW(L"kernelbase.dll");
    auto function = kernelBase ? GetProcAddress(kernelBase, "GetCommandLineW") : nullptr;
    if (!function) { VirtualFree(buffer, 0, MEM_RELEASE); return FALSE; }
    augmentedCommandLine = buffer;
    if (!Wh_SetFunctionHook(reinterpret_cast<void*>(function), reinterpret_cast<void*>(GetCommandLineWHook),
                            reinterpret_cast<void**>(&originalGetCommandLineW))) {
        augmentedCommandLine = nullptr; VirtualFree(buffer, 0, MEM_RELEASE); return FALSE;
    }
    Wh_Log(L"CNCC: early main-process command-line hook registered");
    return TRUE;
}

void Wh_ModAfterInit() { Wh_Log(L"CNCC: framework completed the early-loading phase"); }

void Wh_ModUninit() {
    // The framework restores its hooks. Keep this small, read-only allocation
    // until process exit: a consumer may retain the Win32 command-line pointer.
    // No official process is stopped and no Windows startup item is registered.
    Wh_Log(L"CNCC: removing the enhancement hook");
}
#endif
