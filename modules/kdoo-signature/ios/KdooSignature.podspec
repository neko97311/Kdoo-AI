require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'KdooSignature'
  s.version        = package['version']
  s.summary        = 'KDOO Signature Module'
  s.homepage       = 'https://kdoo.app'
  s.license        = 'MIT'
  s.author         = 'KDOO'
  s.platforms      = { :ios => '15.1', :tvos => '15.1' }
  s.source         = { :git => 'https://github.com/kdoo/kdoo-signature.git', :tag => s.version }
  s.source_files   = '**/*.{h,m,swift}'
  s.dependency 'ExpoModulesCore'
end