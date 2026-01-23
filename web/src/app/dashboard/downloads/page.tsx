'use client';

import { useState, useEffect } from 'react';

interface VersionInfo {
  version: string;
  channel: string;
  releaseDate: string;
  releaseNotes: string | null;
  builds: {
    platform: string;
    arch: string;
    filename: string;
    fileSize: number;
    sha256: string;
  }[];
}

export default function DownloadsPage() {
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState<string | null>(null);

  useEffect(() => {
    fetchVersions();
  }, []);

  const fetchVersions = async () => {
    try {
      const res = await fetch('/api/updates/versions');
      if (res.ok) {
        const data = await res.json();
        setVersions(data.versions || []);
      }
    } catch (error) {
      console.error('Failed to fetch versions:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async (platform: string, arch: string, version: string) => {
    const key = `${platform}-${arch}-${version}`;
    setDownloading(key);

    try {
      const url = `/api/updates/download/${platform}/${arch}/${version}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error('Download failed');
      }

      const blob = await response.blob();
      const filename = response.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1]
        || `ScreenControl-${version}-${platform}-${arch}`;

      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(downloadUrl);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Download error:', error);
      alert('Download failed. Please try again.');
    } finally {
      setDownloading(null);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getPlatformIcon = (platform: string) => {
    switch (platform.toLowerCase()) {
      case 'windows':
        return (
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801"/>
          </svg>
        );
      case 'macos':
        return (
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
          </svg>
        );
      case 'linux':
        return (
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587.26 1.386.41 2.118.41 2.078 0 3.908-.686 3.914-1.758 0-.076-.006-.154-.022-.231.307-.125.543-.4.768-.631.164-.152.288-.324.474-.497.166-.16.317-.277.544-.425.157-.093.322-.177.453-.334a.996.996 0 00.196-.462c.02-.195-.04-.416-.16-.621a.992.992 0 00-.536-.43 5.547 5.547 0 00-1.077-.22c-.27-.034-.55-.086-.79-.188a.942.942 0 01-.246-.137c-.085-.11-.224-.188-.347-.275a.976.976 0 01-.311-.51c-.038-.155-.06-.326-.06-.503 0-1.009.42-2.134.42-2.893 0-.45-.174-.925-.448-1.334-.273-.4-.673-.757-1.108-.983-.437-.226-.92-.345-1.398-.345-.51 0-1.006.13-1.4.397a2.31 2.31 0 00-.94 1.204c-.192.543-.194 1.224.011 1.86.2.63.568 1.195 1.064 1.604.497.41 1.114.649 1.773.649.363 0 .707-.07.99-.19a1.82 1.82 0 00.674-.5 1.69 1.69 0 00.374-.756c.05-.26.055-.538.037-.81a3.03 3.03 0 01-.003-.37c.01-.113.025-.225.06-.334.043-.112.107-.22.194-.317.087-.098.197-.183.317-.257.121-.073.254-.135.392-.18.138-.044.283-.075.428-.092.144-.018.29-.023.436-.015.146.008.292.03.437.065.146.035.29.085.43.15.141.063.277.142.407.234.13.093.254.2.37.32.117.12.225.254.324.4.099.146.188.305.267.475.08.17.148.351.208.542.059.19.107.392.145.601.038.21.066.428.083.654.018.225.024.457.02.695a6.15 6.15 0 01-.057.77c-.03.193-.063.381-.103.564a5.92 5.92 0 01-.146.526 5.1 5.1 0 01-.188.486c-.07.154-.145.302-.227.445a4.2 4.2 0 01-.265.412 3.54 3.54 0 01-.299.37c-.104.116-.214.224-.33.326-.115.1-.236.195-.362.283a4.37 4.37 0 01-.388.246 4.93 4.93 0 01-.412.214 5.6 5.6 0 01-.43.18 6.36 6.36 0 01-.444.144 7.18 7.18 0 01-.452.11 8.04 8.04 0 01-.457.075 8.95 8.95 0 01-.457.043 9.89 9.89 0 01-.452.013c-.15 0-.3-.004-.45-.013z"/>
          </svg>
        );
      default:
        return null;
    }
  };

  const getPlatformName = (platform: string, arch: string) => {
    const names: Record<string, string> = {
      'windows-x64': 'Windows (64-bit)',
      'windows-arm64': 'Windows (ARM64)',
      'macos-arm64': 'macOS (Apple Silicon)',
      'macos-x64': 'macOS (Intel)',
      'linux-x64': 'Linux (64-bit)',
      'linux-arm64': 'Linux (ARM64)',
    };
    return names[`${platform.toLowerCase()}-${arch}`] || `${platform} (${arch})`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">Downloads</h1>
        <p className="text-slate-400">
          Download ScreenControl agents for your platform. After installation, agents will auto-update.
        </p>
      </div>

      {/* Quick Download Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Windows */}
        <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
          <div className="flex items-center gap-3 mb-4">
            <div className="text-blue-400">{getPlatformIcon('windows')}</div>
            <h2 className="text-xl font-semibold text-white">Windows</h2>
          </div>
          <p className="text-slate-400 text-sm mb-4">
            MSI installer for Windows 10/11 (64-bit). Includes service and tray app.
          </p>
          <button
            onClick={() => handleDownload('windows', 'x64', versions[0]?.version || 'latest')}
            disabled={downloading === `windows-x64-${versions[0]?.version}`}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium py-2 px-4 rounded-lg transition flex items-center justify-center gap-2"
          >
            {downloading === `windows-x64-${versions[0]?.version}` ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                Downloading...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download for Windows
              </>
            )}
          </button>
        </div>

        {/* macOS */}
        <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
          <div className="flex items-center gap-3 mb-4">
            <div className="text-slate-300">{getPlatformIcon('macos')}</div>
            <h2 className="text-xl font-semibold text-white">macOS</h2>
          </div>
          <p className="text-slate-400 text-sm mb-4">
            Native app for macOS 12+ (Apple Silicon & Intel). Menu bar agent.
          </p>
          <button
            onClick={() => handleDownload('macos', 'arm64', versions[0]?.version || 'latest')}
            disabled={downloading === `macos-arm64-${versions[0]?.version}`}
            className="w-full bg-slate-600 hover:bg-slate-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-medium py-2 px-4 rounded-lg transition flex items-center justify-center gap-2"
          >
            {downloading === `macos-arm64-${versions[0]?.version}` ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                Downloading...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download for macOS
              </>
            )}
          </button>
        </div>

        {/* Linux */}
        <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
          <div className="flex items-center gap-3 mb-4">
            <div className="text-orange-400">{getPlatformIcon('linux')}</div>
            <h2 className="text-xl font-semibold text-white">Linux</h2>
          </div>
          <p className="text-slate-400 text-sm mb-4">
            Binary for Linux (64-bit). Available in GUI and headless variants.
          </p>
          <button
            onClick={() => handleDownload('linux', 'x64', versions[0]?.version || 'latest')}
            disabled={downloading === `linux-x64-${versions[0]?.version}`}
            className="w-full bg-orange-600 hover:bg-orange-700 disabled:bg-orange-800 disabled:cursor-not-allowed text-white font-medium py-2 px-4 rounded-lg transition flex items-center justify-center gap-2"
          >
            {downloading === `linux-x64-${versions[0]?.version}` ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                Downloading...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download for Linux
              </>
            )}
          </button>
        </div>
      </div>

      {/* Version History */}
      {versions.length > 0 && (
        <div className="bg-slate-800 rounded-lg border border-slate-700">
          <div className="p-6 border-b border-slate-700">
            <h2 className="text-xl font-semibold text-white">All Versions</h2>
          </div>
          <div className="divide-y divide-slate-700">
            {versions.map((version) => (
              <div key={version.version} className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-medium text-white flex items-center gap-2">
                      Version {version.version}
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        version.channel === 'STABLE' ? 'bg-green-500/20 text-green-400' :
                        version.channel === 'BETA' ? 'bg-yellow-500/20 text-yellow-400' :
                        'bg-slate-500/20 text-slate-400'
                      }`}>
                        {version.channel}
                      </span>
                    </h3>
                    <p className="text-slate-400 text-sm">
                      Released {new Date(version.releaseDate).toLocaleDateString()}
                    </p>
                  </div>
                </div>

                {version.releaseNotes && (
                  <p className="text-slate-300 text-sm mb-4">{version.releaseNotes}</p>
                )}

                <div className="flex flex-wrap gap-2">
                  {version.builds.map((build) => (
                    <button
                      key={`${build.platform}-${build.arch}`}
                      onClick={() => handleDownload(build.platform.toLowerCase(), build.arch, version.version)}
                      disabled={downloading === `${build.platform.toLowerCase()}-${build.arch}-${version.version}`}
                      className="inline-flex items-center gap-2 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:cursor-not-allowed text-white text-sm py-1.5 px-3 rounded-lg transition"
                    >
                      {getPlatformIcon(build.platform)}
                      <span>{getPlatformName(build.platform, build.arch)}</span>
                      <span className="text-slate-400">({formatSize(build.fileSize)})</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {versions.length === 0 && !loading && (
        <div className="bg-slate-800 rounded-lg border border-slate-700 p-8 text-center">
          <p className="text-slate-400">No versions available yet.</p>
        </div>
      )}

      {/* Installation Instructions */}
      <div className="bg-slate-800 rounded-lg border border-slate-700 p-6">
        <h2 className="text-xl font-semibold text-white mb-4">Installation Instructions</h2>

        <div className="space-y-4">
          <div>
            <h3 className="text-white font-medium mb-2">Windows</h3>
            <ol className="text-slate-400 text-sm space-y-1 list-decimal list-inside">
              <li>Download the MSI installer</li>
              <li>Run the installer (requires Administrator privileges)</li>
              <li>The service starts automatically and the tray app appears</li>
              <li>Configure your connection in the tray app settings</li>
            </ol>
          </div>

          <div>
            <h3 className="text-white font-medium mb-2">macOS</h3>
            <ol className="text-slate-400 text-sm space-y-1 list-decimal list-inside">
              <li>Download and extract the .app.tar.gz file</li>
              <li>Move ScreenControl.app to /Applications</li>
              <li>Launch and grant Accessibility and Screen Recording permissions</li>
              <li>The menu bar icon appears when running</li>
            </ol>
          </div>

          <div>
            <h3 className="text-white font-medium mb-2">Linux</h3>
            <ol className="text-slate-400 text-sm space-y-1 list-decimal list-inside">
              <li>Download the binary for your variant (GUI or headless)</li>
              <li>Make executable: <code className="bg-slate-700 px-1 rounded">chmod +x screencontrol</code></li>
              <li>Run: <code className="bg-slate-700 px-1 rounded">./screencontrol</code></li>
              <li>For system service, see the documentation</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
