-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "paymentMethod" TEXT NOT NULL DEFAULT 'qr';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "description" TEXT DEFAULT '';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "email" TEXT,
ADD COLUMN     "role" INTEGER NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userPhone_fkey" FOREIGN KEY ("userPhone") REFERENCES "User"("phoneNumber") ON DELETE RESTRICT ON UPDATE CASCADE;
