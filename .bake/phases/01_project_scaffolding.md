# 01_project_scaffolding

## Objective
Initialize ESP32-C3 project with SDK configuration, partition table, and build toolchain

## Done When
Custom 4 MB partition table (partitions.csv) committed with dual OTA slots and LittleFS allocation. SDK config restricts mbedtls to 4096-byte SSL frames. Compiles cleanly for ESP32-C3 RISC-V target.
