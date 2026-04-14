import sharp from 'sharp';
import fs from 'fs';
import chalk from 'chalk';

export class ImageProcessor {
    private static readonly CROP_CONFIG = {
        left: 48,
        top: 46,
        width: 1836,
        height: 1004,
    };

    /**
     * Кропает изображения и перезаписывает оригиналы
     * @param filePaths Пути к файлам для кропа
     */
    public async cropImages(filePaths: string[]): Promise<void> {
        for (const filePath of filePaths) {
            try {
                if (!fs.existsSync(filePath)) {
                    console.warn(chalk.yellow(`⚠️ Файл не найден для кропа: ${filePath}`));
                    continue;
                }

                console.log(chalk.blue(`🖼️ Кропаем изображение: ${filePath}...`));

                // Читаем в буфер, чтобы не было конфликтов при перезаписи
                const buffer = await sharp(filePath)
                    .extract(ImageProcessor.CROP_CONFIG)
                    .toBuffer();

                // Перезаписываем оригинал
                fs.writeFileSync(filePath, buffer);

                console.log(chalk.green(`✅ Кроп выполнен для: ${filePath}`));
            } catch (error: any) {
                console.error(chalk.red(`❌ Ошибка при кропе файла ${filePath}:`), error.message);
                throw error;
            }
        }
    }
}
