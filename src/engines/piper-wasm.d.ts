declare module '@diffusionstudio/piper-wasm/build/piper_phonemize.js' {
  interface PhonemizeModule {
    callMain(args: string[]): void;
  }
  interface PhonemizeOptions {
    print?: (line: string) => void;
    printErr?: (line: string) => void;
    locateFile?: (file: string) => string;
  }
  const createPiperPhonemize: (options?: PhonemizeOptions) => Promise<PhonemizeModule>;
  export default createPiperPhonemize;
}
