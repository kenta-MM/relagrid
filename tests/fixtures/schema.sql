CREATE DATABASE relagrid_fixture CHARACTER SET utf8mb4;
USE relagrid_fixture;
CREATE TABLE Customer (customer_id BIGINT PRIMARY KEY, name VARCHAR(100), email VARCHAR(255));
CREATE TABLE `Order` (order_id BIGINT PRIMARY KEY, customer_id BIGINT NOT NULL, amount DECIMAL(12,2), memo TEXT, payload BLOB, created_at DATETIME, FOREIGN KEY (customer_id) REFERENCES Customer(customer_id));
INSERT INTO Customer VALUES (1, '青木', 'aoki@example.com');
INSERT INTO `Order` VALUES (1052, 1, 1234.50, NULL, X'00FF', '2026-09-20 12:00:00');
