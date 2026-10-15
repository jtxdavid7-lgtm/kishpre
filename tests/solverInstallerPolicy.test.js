import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const installer = fs.readFileSync(
  path.resolve('scripts/solver-ui/companion/install.ps1'),
  'utf8'
);

describe('Windows solver installer policy compatibility', () => {
  it('keeps OS integrations optional after the core health check', () => {
    const healthGate = installer.indexOf("if (-not $health)");
    const optionalStep = installer.indexOf('Invoke-OptionalInstallStep');
    const optionalInvocation = installer.indexOf(
      "Invoke-OptionalInstallStep -Name 'Registering automatic start...'"
    );

    expect(optionalStep).toBeGreaterThanOrEqual(0);
    expect(healthGate).toBeGreaterThanOrEqual(0);
    expect(optionalInvocation).toBeGreaterThan(healthGate);
    expect(installer).not.toContain("HKCU:\\Software\\Classes\\kishsolver");
    expect(installer).not.toContain("HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run");
  });

  it('uses a fresh versioned directory and never deletes the legacy runtime', () => {
    expect(installer).toContain('$installRoot = "$installPrefix $expectedVersion"');
    expect(installer).toContain("[Guid]::NewGuid().ToString('N').Substring(0, 8)");
    expect(installer).not.toContain('Remove-Item -LiteralPath $resolvedInstall');
  });

  it('starts the core without depending on WScript or VBScript', () => {
    expect(installer).toContain('$commandShell = $env:ComSpec');
    expect(installer).toContain('Start-Process -FilePath $commandShell');
    expect(installer).not.toContain('Start-Process -FilePath $wscript');
  });

  it('writes actionable failure stage and policy diagnostics', () => {
    expect(installer).toContain('Stage: $script:installStage');
    expect(installer).toContain('FullyQualifiedErrorId:');
    expect(installer).toContain('HResult:');
  });
});
