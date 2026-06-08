import React, { useState } from 'react';
import { readFile, writeFile, listDirectory, fileExists, type DirEntry } from '../utils/fs';
import styles from './FileSystemTest.module.css';

type DirectoryListEntry = DirEntry & {
  children?: DirectoryListEntry[];
};

const FileSystemTest: React.FC = () => {
  const [filePath, setFilePath] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [dirPath, setDirPath] = useState('');
  const [dirContents, setDirContents] = useState<DirectoryListEntry[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const handleReadFile = async () => {
    if (!filePath) {
      setStatus('Please enter a file path');
      return;
    }

    try {
      setStatus('Reading file...');
      const exists = await fileExists(filePath);

      if (!exists) {
        setError(`File does not exist: ${filePath}`);
        setStatus('Failed');
        return;
      }

      const content = await readFile(filePath);
      setFileContent(content);
      setStatus('File read successfully');
      setError('');
    } catch (err) {
      setError(`Error reading file: ${err instanceof Error ? err.message : String(err)}`);
      setStatus('Failed');
    }
  };

  const handleWriteFile = async () => {
    if (!filePath) {
      setStatus('Please enter a file path');
      return;
    }

    try {
      setStatus('Writing file...');
      await writeFile(filePath, fileContent);
      setStatus('File written successfully');
      setError('');
    } catch (err) {
      setError(`Error writing file: ${err instanceof Error ? err.message : String(err)}`);
      setStatus('Failed');
    }
  };

  const handleListDirectory = async () => {
    if (!dirPath) {
      setStatus('Please enter a directory path');
      return;
    }

    try {
      setStatus('Reading directory...');
      const exists = await fileExists(dirPath);

      if (!exists) {
        setError(`Directory does not exist: ${dirPath}`);
        setStatus('Failed');
        return;
      }

      const contents = (await listDirectory(dirPath)) as DirectoryListEntry[];
      setDirContents(contents);
      setStatus('Directory read successfully');
      setError('');
    } catch (err) {
      setError(`Error reading directory: ${err instanceof Error ? err.message : String(err)}`);
      setStatus('Failed');
    }
  };

  return (
    <div className={styles.container}>
      <h2>File System Test</h2>

      <div className={styles.section}>
        <h3>Read/Write File</h3>
        <div className={styles.inputRow}>
          <input
            type="text"
            value={filePath}
            onChange={(e) => setFilePath(e.target.value)}
            placeholder="Enter file path"
            className={styles.input}
          />
          <button onClick={handleReadFile}>Read File</button>
          <button onClick={handleWriteFile}>Write File</button>
        </div>
        <textarea
          value={fileContent}
          onChange={(e) => setFileContent(e.target.value)}
          placeholder="File content will appear here / Enter content to write"
          className={styles.textarea}
        />
      </div>

      <div>
        <h3>List Directory</h3>
        <div className={styles.inputRow}>
          <input
            type="text"
            value={dirPath}
            onChange={(e) => setDirPath(e.target.value)}
            placeholder="Enter directory path"
            className={styles.input}
          />
          <button onClick={handleListDirectory}>List Directory</button>
        </div>
        <div className={styles.listSection}>
          <ul>
            {dirContents.map((entry) => (
              <li key={`${entry.name}-${entry.children ? 'dir' : 'file'}`}>
                {entry.name} {entry.children ? '(Directory)' : '(File)'}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className={styles.status}>
        <p>
          Status: <strong>{status}</strong>
        </p>
        {error && <p className={styles.error}>{error}</p>}
      </div>
    </div>
  );
};

export default FileSystemTest;
