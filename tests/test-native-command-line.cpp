#define CNCC_CORE_ONLY
#include "../src/native/codex-nested-autoload.wh.cpp"
#include <cassert>
#include <iostream>

int wmain() {
    using cncc::BuildCandidate;
    const std::wstring family = cncc::kFamily;
    const std::wstring image = L"D:\\WindowsApps\\OpenAI.Codex_1.2.3_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe";
    const std::wstring raw = L"\"" + image + L"\"";
    const auto base = BuildCandidate(family, image, raw);
    assert(base.augment && base.command == raw + cncc::kSuffix);
    assert(base.command.find(L"127.0.0.1") != std::wstring::npos);
    assert(!BuildCandidate(L"Other.Package", image, raw).augment);
    assert(!BuildCandidate(L"", image, raw).augment);
    assert(!BuildCandidate(family, L"C:\\ChatGPT-copy.exe", raw).augment);
    assert(!BuildCandidate(family, image, raw + L" --type=renderer").augment);
    assert(!BuildCandidate(family, image, raw + L" --type utility").augment);
    assert(!BuildCandidate(family, image, raw + L" -type=renderer").augment);
    assert(!BuildCandidate(family, image, raw + L" /type=renderer").augment);
    assert(!BuildCandidate(family, image, raw + L" --TYPE=renderer").augment);
    assert(!BuildCandidate(family, image, raw + L" \"--type=gpu-process\"").augment);
    assert(!BuildCandidate(family, image, raw + L" --remote-debugging-port=9222").augment);
    assert(!BuildCandidate(family, image, raw + L" --remote-debugging-pipe").augment);
    assert(!BuildCandidate(family, image, raw + L" -remote-debugging-port=1234").augment);
    assert(!BuildCandidate(family, image, raw + L" /remote-debugging-port=1234").augment);
    assert(!BuildCandidate(family, image, raw + L" --REMOTE-DEBUGGING-PIPE").augment);
    assert(!BuildCandidate(family, image, raw + L" --remote-debugging-address=0.0.0.0").augment);
    assert(!BuildCandidate(family, image, base.command).augment);
    assert(!BuildCandidate(family, image, raw + L" -- document.txt").augment);
    assert(!BuildCandidate(family, image, raw + L" --single-argument https://example.com").augment);
    assert(!BuildCandidate(family, image, std::wstring(32767, L'x')).augment);
    assert(!BuildCandidate(family, image, L"").augment);
    assert(BuildCandidate(family, image, raw + L" --typewriter=test --unknown=value").augment);
    assert(BuildCandidate(family, image, raw + L" \"document --type=renderer.txt\"").augment);
    assert(BuildCandidate(family, image, raw + L" --remote-debugging-port-file=unused").augment);
    const auto updated = BuildCandidate(family, L"E:\\WindowsApps\\OpenAI.Codex_99.0.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe", raw);
    assert(updated.augment);
    assert(cncc::IsOfficialImage(L"D:\\WindowsApps\\OpenAI.Codex_1.2.3_x64__2p2nqsd0c76g0", image));
    assert(cncc::IsOfficialImage(L"D:\\WindowsApps\\OpenAI.Codex_1.2.3_x64__2p2nqsd0c76g0\\", image));
    assert(!cncc::IsOfficialImage(L"C:\\Other", image));
    assert(!cncc::IsOfficialImage(L"", image));
    assert(!cncc::IsOfficialImage(L"D:\\WindowsApps\\OpenAI.Codex_1.2.3_x64__2p2nqsd0c76g0", L"C:\\ChatGPT.exe"));
    std::cout << "Native command-line payload: 31 checks passed. No official process or registry was accessed.\n";
}
