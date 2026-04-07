import { toast } from 'react-toastify';
import { useStore } from '@nanostores/react';
import { workbenchStore } from '~/lib/stores/workbench';
import { webcontainer } from '~/lib/webcontainer';
import { path } from '~/utils/path';
import { useState } from 'react';
import type { ActionCallbackData } from '~/lib/runtime/message-parser';
import { chatId } from '~/lib/persistence/useChatHistory';
import { formatBuildFailureOutput } from './deployUtils';

// The API server URL (production backend)
const PREVIEW_API_URL = 'https://api.daggpt.network/api/preview';

export function useSharePreview() {
  const [isSharing, setIsSharing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const currentChatId = useStore(chatId);

  const handleSharePreview = async (): Promise<string | null> => {
    if (!currentChatId) {
      toast.error('No active chat found');
      return null;
    }

    try {
      setIsSharing(true);

      const artifact = workbenchStore.firstArtifact;

      if (!artifact) {
        throw new Error('No active project found');
      }

      // Notify building
      toast.info('🔨 Building project for preview...', { autoClose: 3000 });

      // Build the project first
      const actionId = 'build-preview-' + Date.now();
      const actionData: ActionCallbackData = {
        messageId: 'share-preview-build',
        artifactId: artifact.id,
        actionId,
        action: {
          type: 'build' as const,
          content: 'npm run build',
        },
      };

      artifact.runner.addAction(actionData);
      await artifact.runner.runAction(actionData);

      const buildOutput = artifact.runner.buildOutput;

      if (!buildOutput || buildOutput.exitCode !== 0) {
        throw new Error('Build failed: ' + formatBuildFailureOutput(buildOutput?.output));
      }

      // Get the build output files from WebContainer
      const container = await webcontainer;
      const buildPath = buildOutput.path.replace('/home/project', '');

      // Find the correct build output directory
      let finalBuildPath = buildPath;
      const commonOutputDirs = [buildPath, '/dist', '/build', '/out', '/output', '/public'];
      let buildPathExists = false;

      for (const dir of commonOutputDirs) {
        try {
          await container.fs.readdir(dir);
          finalBuildPath = dir;
          buildPathExists = true;
          break;
        } catch {
          continue;
        }
      }

      if (!buildPathExists) {
        throw new Error('Could not find build output directory.');
      }

      // Recursively read all files from the build directory
      async function getAllFiles(dirPath: string): Promise<Record<string, string>> {
        const files: Record<string, string> = {};
        const entries = await container.fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);

          if (entry.isFile()) {
            const content = await container.fs.readFile(fullPath, 'utf-8');
            const deployPath = fullPath.replace(finalBuildPath, '').replace(/^\//, '');
            files[deployPath] = content;
          } else if (entry.isDirectory()) {
            const subFiles = await getAllFiles(fullPath);
            Object.assign(files, subFiles);
          }
        }

        return files;
      }

      toast.info('📦 Uploading preview...', { autoClose: 3000 });

      const fileContents = await getAllFiles(finalBuildPath);

      if (Object.keys(fileContents).length === 0) {
        throw new Error('No files found in build output');
      }

      // Upload to our preview API
      const response = await fetch(`${PREVIEW_API_URL}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: fileContents,
          projectName: workbenchStore.firstArtifact?.title || 'Untitled',
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({ error: 'Upload failed' }))) as { error?: string };
        throw new Error(errorData.error || 'Failed to upload preview');
      }

      const data = (await response.json()) as { success?: boolean; previewUrl?: string };

      if (!data.success || !data.previewUrl) {
        throw new Error('Invalid response from preview service');
      }

      setPreviewUrl(data.previewUrl);

      // Store the preview URL for this chat
      localStorage.setItem(`preview-url-${currentChatId}`, data.previewUrl);

      toast.success(
        <div>
          <strong>🚀 Preview live!</strong>
          <br />
          <a href={data.previewUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#667eea' }}>
            {data.previewUrl}
          </a>
        </div>,
        { autoClose: 10000 },
      );

      return data.previewUrl;
    } catch (error) {
      console.error('Share preview error:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to create preview');
      return null;
    } finally {
      setIsSharing(false);
    }
  };

  return {
    isSharing,
    previewUrl,
    handleSharePreview,
  };
}
