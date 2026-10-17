declare module 'arabic-persian-reshaper' {
  const reshaper: {
    PersianShaper: {
      convertArabic: (text: string) => string;
      convertArabicBack: (text: string) => string;
    };
    ArabicShaper: {
      convertArabic: (text: string) => string;
      convertArabicBack: (text: string) => string;
    };
  };
  export default reshaper;
}

declare module 'bidi-js' {
  export default function bidiFactory(): {
    getEmbeddingLevels: (text: string, direction?: string) => Uint8Array | number[];
    getReorderedString: (text: string, levels: any) => string;
    getReorderedIndices: (text: string, levels: any) => number[];
  };
}
