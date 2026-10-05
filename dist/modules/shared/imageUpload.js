"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadedImages = exports.optionalImageUpload = void 0;
const multer_1 = __importDefault(require("multer"));
const node_path_1 = __importDefault(require("node:path"));
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maximumImageBytes = 5 * 1024 * 1024;
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: maximumImageBytes, files: 3 },
    fileFilter: (req, file, callback) => {
        if (!allowedImageTypes.has(file.mimetype)) {
            callback(new Error('Use imagens JPEG, PNG ou WebP.'));
            return;
        }
        callback(null, true);
    },
}).array('images', 3);
const hasValidSignature = (file) => {
    const bytes = file.buffer;
    if (file.mimetype === 'image/jpeg') {
        return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    if (file.mimetype === 'image/png') {
        return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
    return file.mimetype === 'image/webp' && bytes.length >= 12 &&
        bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
};
const optionalImageUpload = (req, res, next) => {
    upload(req, res, (error) => {
        if (error instanceof multer_1.default.MulterError) {
            const message = error.code === 'LIMIT_FILE_SIZE'
                ? 'Cada imagem pode ter até 5 MB.'
                : 'Envie no máximo 3 imagens por registro.';
            return res.status(400).json({ message });
        }
        if (error) {
            return res.status(400).json({ message: error instanceof Error ? error.message : 'Não foi possível ler as imagens.' });
        }
        const files = req.files ?? [];
        if (files.some((file) => !hasValidSignature(file))) {
            return res.status(400).json({ message: 'O conteúdo dos arquivos não corresponde a uma imagem JPEG, PNG ou WebP válida.' });
        }
        return next();
    });
};
exports.optionalImageUpload = optionalImageUpload;
const uploadedImages = (req) => (req.files ?? []).map((file) => ({
    fileName: node_path_1.default.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255) || 'imagem',
    contentType: file.mimetype,
    sizeBytes: file.size,
    data: new Uint8Array(file.buffer),
}));
exports.uploadedImages = uploadedImages;
