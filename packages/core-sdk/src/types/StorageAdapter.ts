/**
 * Configuration for LocalStorageService.
 */
export interface LocalStorageServiceConfig {
    /** Key prefix. Defaults to "privacy-pool". */
    prefix?: string;
}

/**
 * Configuration for FileStorageService.
 */
export interface FileStorageServiceConfig {
    /** Filename (without extension) used for the JSON file. */
    filename: string;
    /** Directory path where the JSON file will be stored. Created if absent. */
    dirPath: string;
}
