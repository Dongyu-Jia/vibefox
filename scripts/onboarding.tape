# Records `vf init` against local mock services. From the repo root:
#   node scripts/mock-services.ts /tmp/vf-mocks.env &   then   vhs scripts/onboarding.tape
Output evidence/videos/onboarding.mp4
Set Shell "bash"
Set FontSize 15
Set Width 1300
Set Height 900
Set Padding 20
Set TypingSpeed 30ms
Set Theme "Catppuccin Mocha"

Hide
Type "source /tmp/vf-mocks.env && export VF_HOME=/tmp/vf-vhs-home VF_SECRETS=file VF_MOCK_LINK_STATE=/tmp/vf-vhs-link.json VF_MOCK_LINK_AUTH=0 PATH=$PWD/bin:$PATH PS1='$ ' && rm -rf /tmp/vf-vhs-home /tmp/vf-vhs-link.json && clear"
Enter
Sleep 1.5s
Show

Type "vf init"
Sleep 400ms
Enter
Sleep 2s
Type "Fox"
Enter
Sleep 900ms
Type "Dongyu"
Enter
Sleep 900ms
Enter
Sleep 1.2s
Enter
Sleep 5s
Enter
Sleep 2.5s
Enter
Sleep 700ms
Enter
Sleep 700ms
Enter
Sleep 700ms
Enter
Sleep 1.5s
Type "123456789:TEST-telegram-token-abcdefghijklmnop"
Enter
Sleep 2.5s
Type "am_test_key_0123456789abcdef"
Enter
Sleep 1.2s
Enter
Sleep 2.5s
Type "ap_test_key_0123456789abcdef"
Enter
Sleep 1s
Type "415"
Enter
Sleep 2.5s
Enter
Sleep 600ms
Enter
Sleep 600ms
Enter
Sleep 500ms
Enter
Sleep 500ms
Enter
Sleep 500ms
Enter
Sleep 500ms
Enter
Sleep 1.5s
Type "yes"
Enter
Sleep 2s
Enter
Sleep 4s
Enter
Sleep 4s
Type "dongyu@example.com"
Enter
Sleep 700ms
Type "+14155550100"
Enter
Sleep 1s
Type "n"
Enter
Sleep 5s
Type "vf identity"
Enter
Sleep 5s
