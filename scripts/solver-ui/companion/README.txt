KishPoker Solver Companion (Windows x64)
================================================

Recommended: download the setup EXE and double-click it once. It installs the
companion for the current Windows user, starts it, and opens KishPoker.

ZIP fallback: extract the ZIP, then double-click install.cmd.

The installer shows each installation stage and displays a final success or
failure message. If installation fails, troubleshooting details are kept at:
  %LOCALAPPDATA%\KishPoker\Solver\install.log

The core runtime is installed for the current user in a fresh versioned
LocalAppData directory. Windows may block the optional automatic-start or
Start-menu shortcut on managed computers; that warning does not prevent the
Solver from starting and connecting for the current session.

Automated tests may set KISH_SOLVER_INSTALL_UNATTENDED=1 to suppress dialogs,
browser launch, and failure pauses. The legacy KISH_SOLVER_INSTALL_NO_BROWSER=1
test switch remains supported and is also kept noninteractive.

The companion runs only on 127.0.0.1:8788. Solver calculations use this
computer's CPU and memory. Job data is stored under:
  %LOCALAPPDATA%\KishPoker\Solver

The official KishPoker website and local development pages are the only browser
origins allowed to call the local API.

This package includes the corresponding source and AGPL license for the modified
postflop-solver engine under source\postflop-solver. Third-party runtime notices
are listed in THIRD_PARTY_NOTICES.txt.
