require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'UnderstageMls'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = 'UNLICENSED'
  s.author         = 'Understage'
  s.homepage       = 'https://openmls.tech'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = 'UnderstageMlsModule.swift', 'MlsWrappingKey.swift', 'generated/*.swift'
  s.exclude_files = 'MlsCore.xcframework/**', 'generated/*.{h,modulemap}'
  s.vendored_frameworks = 'MlsCore.xcframework'
  s.libraries = 'c++'
  s.frameworks = 'Security', 'SystemConfiguration', 'CoreFoundation'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'OTHER_LDFLAGS' => '$(inherited) -lc++'
  }
end
